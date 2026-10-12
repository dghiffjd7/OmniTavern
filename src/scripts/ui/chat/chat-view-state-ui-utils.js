const fallbackEscapeSelector = (value) => String(value || '').replace(/[^a-zA-Z0-9_-]/g, '\\$&');

export const clearMessagesCore = ({
  scrollEl,
  cleanupRichTextMounts,
  hideReactionPicker,
  hideScrollDateBadge,
  hideScrollBottomButton,
  clearDeliverySequence,
  clearTypingTimers,
  getReadCountTimer,
  setReadCountTimer,
  setReadCountCurrent,
  setReadCountMax,
  setReadCountTargets,
  setDeliverySequenceDone,
  setTypingEl,
  getFloatingTypingEl,
  setFloatingTypingEl,
  setRpFloorCount,
} = {}) => {
  if (!scrollEl) return false;
  cleanupRichTextMounts?.(scrollEl);
  scrollEl.innerHTML = '';
  hideReactionPicker?.();
  hideScrollDateBadge?.({ immediate: true });
  hideScrollBottomButton?.({ immediate: true });
  clearDeliverySequence?.();
  clearTypingTimers?.();
  const readCountTimer = getReadCountTimer?.();
  if (readCountTimer) {
    clearTimeout(readCountTimer);
    setReadCountTimer?.(null);
  }
  setReadCountCurrent?.(0);
  setReadCountMax?.(0);
  setReadCountTargets?.(null);
  setDeliverySequenceDone?.(false);
  setTypingEl?.(null);
  const floatingTypingEl = getFloatingTypingEl?.();
  if (floatingTypingEl) {
    floatingTypingEl.remove?.();
    setFloatingTypingEl?.(null);
  }
  setRpFloorCount?.(0);
  return true;
};

export const showConversationLoadingCore = ({
  title = '',
  isGroup = false,
  scrollEl,
  documentLike,
  clearMessages,
  scheduleScrollBottomButtonRefresh,
} = {}) => {
  if (!scrollEl || !documentLike) return false;
  clearMessages?.();
  const wrapper = documentLike.createElement('div');
  wrapper.style.display = 'flex';
  wrapper.style.flexDirection = 'column';
  wrapper.style.gap = '12px';
  wrapper.style.padding = '16px 14px 22px';
  wrapper.style.pointerEvents = 'none';

  const header = documentLike.createElement('div');
  header.style.display = 'flex';
  header.style.alignItems = 'center';
  header.style.gap = '8px';
  header.style.color = 'var(--app-text-muted)';
  header.style.fontSize = '12px';
  header.style.padding = '2px 4px 8px';
  header.textContent = title ? `正在载入 ${title}` : `正在载入${isGroup ? '群聊' : '聊天'}`;
  wrapper.appendChild(header);

  const buildRow = (align = 'left', width = '72%') => {
    const row = documentLike.createElement('div');
    row.style.display = 'flex';
    row.style.justifyContent = align === 'right' ? 'flex-end' : 'flex-start';
    row.style.alignItems = 'flex-end';
    row.style.gap = '8px';

    if (align === 'left') {
      const avatar = documentLike.createElement('div');
      avatar.style.width = '30px';
      avatar.style.height = '30px';
      avatar.style.borderRadius = '999px';
      avatar.style.background = 'var(--app-surface-subtle)';
      avatar.style.flex = '0 0 auto';
      row.appendChild(avatar);
    }

    const bubble = documentLike.createElement('div');
    bubble.style.width = width;
    bubble.style.maxWidth = '78%';
    bubble.style.background = 'var(--app-surface-card)';
    bubble.style.border = '1px solid var(--app-border-subtle)';
    bubble.style.borderRadius = '16px';
    bubble.style.padding = '12px 14px';
    bubble.style.display = 'flex';
    bubble.style.flexDirection = 'column';
    bubble.style.gap = '8px';

    const lineA = documentLike.createElement('div');
    lineA.style.height = '10px';
    lineA.style.width = '82%';
    lineA.style.borderRadius = '999px';
    lineA.style.background = 'var(--app-border-default)';
    bubble.appendChild(lineA);

    const lineB = documentLike.createElement('div');
    lineB.style.height = '10px';
    lineB.style.width = align === 'right' ? '58%' : '66%';
    lineB.style.borderRadius = '999px';
    lineB.style.background = 'var(--app-border-subtle)';
    bubble.appendChild(lineB);

    row.appendChild(bubble);
    wrapper.appendChild(row);
  };

  buildRow('left', '68%');
  buildRow('right', '56%');
  buildRow('left', '74%');
  scrollEl.appendChild(wrapper);
  scrollEl.scrollTop = 0;
  scheduleScrollBottomButtonRefresh?.({ immediate: true });
  return wrapper;
};

export const clearInputCore = ({
  inputEl,
  options = {},
} = {}) => {
  if (!inputEl) return false;
  const shouldFocus = options === true
    || (typeof options === 'object' ? options.focus !== false : options !== false);
  const resizeInput = () => {
    if (!inputEl?.style) return;
    inputEl.style.height = 'auto';
    const scrollHeight = Number(inputEl.scrollHeight || 0);
    if (scrollHeight > 0) inputEl.style.height = `${scrollHeight}px`;
  };
  inputEl.value = '';
  resizeInput();
  try {
    inputEl.dispatchEvent?.(new Event('input', { bubbles: true }));
  } catch {}
  resizeInput();
  if (shouldFocus) inputEl.focus?.();
  return true;
};

export const updateSendButtonStateCore = ({
  sendBtn,
  isSending = false,
  isStreaming = false,
  isRevealing = false,
  isOnline = true,
  continueButton = null,
} = {}) => {
  if (!sendBtn) return false;
  const isBusy = Boolean(isSending) || Boolean(isStreaming);
  // 揭示动画播放中发送键即跳过键（生成中的停止语义优先）。
  const revealing = !isBusy && Boolean(isRevealing);
  const disabled = !Boolean(isOnline);
  sendBtn.disabled = disabled;
  sendBtn.classList?.toggle?.('is-generating', isBusy);
  sendBtn.classList?.toggle?.('is-revealing', revealing);
  const label = !isOnline ? '离线' : (isBusy ? '停止生成' : (revealing ? '跳过动画' : '发送'));
  sendBtn.setAttribute?.('aria-label', label);
  sendBtn.setAttribute?.('title', label);
  if (isOnline) sendBtn.classList?.remove?.('is-offline');
  else sendBtn.classList?.add?.('is-offline');
  if (continueButton) continueButton.disabled = isBusy || disabled;
  return { isBusy, revealing, disabled, label };
};

export const scrollToBottomCore = ({
  scrollEl,
  isStreaming = false,
  setProgrammaticScroll,
  setProgrammaticStreamFollowScroll,
  setStreamAutoFollow,
  scheduleScrollBottomButtonRefresh,
} = {}) => {
  if (!scrollEl) return false;
  setProgrammaticScroll?.(true);
  setProgrammaticStreamFollowScroll?.(true);
  scrollEl.scrollTop = scrollEl.scrollHeight;
  if (isStreaming) setStreamAutoFollow?.(true);
  scheduleScrollBottomButtonRefresh?.({ immediate: true });
  return true;
};

export const scrollToMessageCore = ({
  msgId,
  scrollEl,
  setProgrammaticStreamFollowScroll,
  scheduleScrollBottomButtonRefresh,
  smooth = false,
  // 远距离时盖住「先移到目标附近」那一下：teleport(move, direction) 负责淡出→执行 move→淡入
  teleport = null,
} = {}) => {
  const id = String(msgId || '').trim();
  if (!id || !scrollEl) return false;
  const escape = globalThis.CSS?.escape || fallbackEscapeSelector;
  const element = scrollEl.querySelector?.(`[data-msg-id="${escape(id)}"]`);
  if (!element) return false;
  const top = element.offsetTop - 12;
  setProgrammaticStreamFollowScroll?.(true);
  if (smooth && typeof scrollEl.scrollTo === 'function') {
    // 落点在真正移动时再读：过场淡出期间版面仍可能变化
    // 平滑滑过去；距离很远时先移到目标前一小段（约 240px）再滑，避免一路飞过整段长文、也不让大片内容快速扫过
    const target = Math.max(0, top);
    const viewport = Number(scrollEl.clientHeight) || 0;
    const distance = target - (Number(scrollEl.scrollTop) || 0);
    const targetNow = () => Math.max(0, (Number(element.offsetTop) || 0) - 12);
    const slide = () => scrollEl.scrollTo({ top: targetNow(), behavior: 'smooth' });
    if (viewport > 0 && Math.abs(distance) > viewport * 1.5) {
      const move = () => {
        scrollEl.scrollTop = Math.max(0, targetNow() - Math.sign(distance) * Math.min(viewport * 0.3, 240));
        slide();
      };
      if (typeof teleport === 'function') teleport(move, distance > 0 ? 'down' : 'up');
      else move();
    } else {
      slide();
    }
  } else {
    scrollEl.scrollTop = Math.max(0, top);
  }
  scheduleScrollBottomButtonRefresh?.({ immediate: true });
  return element;
};
