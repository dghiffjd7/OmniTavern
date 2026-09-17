const waitForMenuDismissalPaint = (windowLike = null) => new Promise((resolve) => {
  const raf = windowLike && typeof windowLike.requestAnimationFrame === 'function'
    ? windowLike.requestAnimationFrame.bind(windowLike)
    : null;
  if (raf) {
    raf(() => resolve());
    return;
  }
  setTimeout(resolve, 0);
});

export const showContextMenuCore = ({
  event,
  message,
  selectionMode = false,
  contextMenu = null,
  navigatorLike = null,
  scrollEl = null,
  hideReactionPicker = null,
  resolveContextMenuContext = null,
  buildContextMenuActions = null,
  canCheckFormatForMessage = null,
  isThreadingEnabledForMessage = null,
  normalizeReactionEntries = null,
  createContextMenuReactionRow = null,
  defaultReactionEmojis = [],
  isSelfReaction = null,
  toggleReaction = null,
  createContextMenuActionButton = null,
  createContextMenuDivider = null,
  createContextMenuSpeakRow = null,
  resolveSpeakQuickVoices = null,
  dispatchContextMenuAction = null,
  getPoint = null,
  positionContextMenu = null,
  actionHandler = null,
  clearLongPress = null,
  openCodeViewer = null,
  getBubbleCopyText = null,
  copyToClipboard = null,
  startInlineEdit = null,
  enterSelectionMode = null,
  successToast = null,
  warningToast = null,
  documentLike = null,
  windowLike = null,
} = {}) => {
  if (selectionMode || !contextMenu) return false;
  try { navigatorLike?.vibrate?.(5); } catch {}
  hideReactionPicker?.();
  const {
    wrapper,
    message: resolvedMessage,
    codeBlock,
    hasCode,
    inlineGeneratedImage,
  } = resolveContextMenuContext?.({
    event,
    message,
    scrollEl,
  }) || {};
  const threadingEnabled = Boolean(isThreadingEnabledForMessage?.(resolvedMessage));
  const actions = [
    ...(buildContextMenuActions?.(resolvedMessage, {
      hasCode,
      hasRpMessageActions:
        wrapper?.classList?.contains?.('has-rp-message-actions') === true,
      isThreadingEnabled: threadingEnabled,
      inlineGeneratedImage,
      canCheckFormat: canCheckFormatForMessage?.(resolvedMessage) === true,
    }) || []),
  ];
  contextMenu.innerHTML = '';
  if (threadingEnabled) {
    const currentReactions = normalizeReactionEntries?.(resolvedMessage?.meta?.reactions);
    const reactionRow = createContextMenuReactionRow?.({
      documentLike,
      currentReactions,
      emojis: defaultReactionEmojis,
      isSelfReaction,
      onToggle: (emoji) => {
        contextMenu.style.display = 'none';
        if (typeof toggleReaction === 'function') toggleReaction(resolvedMessage, emoji);
        else actionHandler?.('toggle-reaction', resolvedMessage, { emoji });
      },
    });
    if (reactionRow) contextMenu.appendChild(reactionRow);
  }
  if (resolvedMessage?.role === 'assistant' && typeof createContextMenuSpeakRow === 'function') {
    const dispatchSpeakAction = async (actionKey, payload) => {
      contextMenu.style.display = 'none';
      clearLongPress?.();
      await waitForMenuDismissalPaint(windowLike);
      try {
        await actionHandler?.(actionKey, resolvedMessage, payload);
      } catch {}
    };
    let quickVoices = [];
    try {
      quickVoices = resolveSpeakQuickVoices?.() || [];
    } catch {}
    const speakRow = createContextMenuSpeakRow({
      documentLike,
      quickVoices,
      showSpeakButton: wrapper?.classList?.contains?.('has-rp-message-actions') !== true,
      onSpeak: (voiceRef) => {
        void dispatchSpeakAction('speak', {
          wrapper,
          ...(voiceRef ? { voiceRefOverride: voiceRef } : {}),
        });
      },
      onMore: () => {
        void dispatchSpeakAction('select-voice', { wrapper });
      },
    });
    if (speakRow) contextMenu.appendChild(speakRow);
  }
  let previousGroup = '';
  actions.forEach((action) => {
    const group = String(action?.group || 'default');
    if (previousGroup && group !== previousGroup) {
      const divider = createContextMenuDivider?.({ documentLike });
      if (divider) contextMenu.appendChild(divider);
    }
    previousGroup = group;
    const button = createContextMenuActionButton?.({
      documentLike,
      action,
      onClick: async (nextEvent) => {
        nextEvent.preventDefault?.();
        nextEvent.stopPropagation?.();
        const hideMenu = () => {
          contextMenu.style.display = 'none';
        };
        hideMenu();
        clearLongPress?.();
        await waitForMenuDismissalPaint(windowLike);
        try {
          await dispatchContextMenuAction?.({
            actionKey: action.key,
            message: resolvedMessage,
            wrapper,
            codeBlock,
            hasCode,
            inlineGeneratedImage,
            tryAction: async (key, payload, options = {}) => {
              if (typeof actionHandler !== 'function') return false;
              try {
                const handled = await actionHandler(key, resolvedMessage, payload);
                if (options.skipFallback === true) return handled;
                return handled;
              } catch {
                return false;
              }
            },
            hideMenu,
            clearLongPress,
            openCodeViewer,
            getBubbleCopyText,
            copyToClipboard,
            showCopyToast: (ok) => {
              if (ok) successToast?.('已复制');
              else warningToast?.('复制失败');
            },
            startInlineEdit,
            enterSelectionMode,
          });
        } finally {
          hideMenu();
        }
      },
    });
    if (button) contextMenu.appendChild(button);
  });
  const { x, y } = getPoint?.(event) || { x: 0, y: 0 };
  positionContextMenu?.(contextMenu, { x, y, windowLike });
  return true;
};
