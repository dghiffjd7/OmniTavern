// 创意写作的「跳转只渲染目标附近」：跳到远处时画面变成「目标附近一页 + 折叠占位 + 原本的最新部分」，
// 最新部分保持接在底部（输出、新增消息照旧）；滚到折叠占位时再一页页补出来。
// 聊天记录数据仍连续加载在内存里，只有画面上的气泡按需渲染；折叠范围用消息 id 记在占位元素上。
import { t } from '../../i18n/index.js';

export const HISTORY_WINDOW_PAD = 15;
export const HISTORY_WINDOW_PAGE = 20;
export const HISTORY_WINDOW_NEAR = 60;

// 计算跳转方式：目标已在画面里 / 离已渲染部分很近（接着往上补）/ 很远（只渲染附近 + 折叠中间）。
export const planHistoryJump = ({ targetIndex, renderedStart, pad = HISTORY_WINDOW_PAD, near = HISTORY_WINDOW_NEAR } = {}) => {
  const k = Math.floor(Number(targetIndex));
  const start = Math.max(0, Math.floor(Number(renderedStart) || 0));
  if (!Number.isFinite(k) || k < 0) return { kind: 'missing' };
  if (k >= start) return { kind: 'rendered' };
  const from = Math.max(0, k - pad);
  if (start - k <= near) return { kind: 'extend', from, to: start - 1 };
  const windowEnd = Math.min(start - 1, k + pad);
  return { kind: 'window', from, to: windowEnd, gapFrom: windowEnd + 1, gapTo: start - 1 };
};

export const createCreativeHistoryWindow = ({
  documentRef = document,
  scrollEl = null,
  chatStore = null,
  ui = null,
  renderState = null,
  getCurrentSessionId = () => '',
  prepareMessages = messages => messages,
  // 立即完成指定气泡里尚未加载的复杂卡片（同步），跳转前让目标附近的气泡先长到最终高度
  flushLazyRich = () => 0,
  onMessagesRendered = () => {},
  logger = null,
} = {}) => {
  if (!scrollEl || !chatStore || !ui || !renderState) return null;

  const messagesOf = sid => chatStore.getMessages?.(sid) || [];
  const indexOf = (sid, id) => messagesOf(sid).findIndex(m => String(m?.id || '') === String(id || ''));
  const placeholder = () => scrollEl.querySelector(':scope > .creative-history-gap');
  const isCurrent = sid => String(getCurrentSessionId() || '').trim() === sid;

  const render = (sid, list) => prepareMessages(list, sid);

  const updatePlaceholderLabel = (sid, gapEl) => {
    const from = indexOf(sid, gapEl.dataset.fromId);
    const to = indexOf(sid, gapEl.dataset.toId);
    const count = from >= 0 && to >= from ? to - from + 1 : 0;
    const label = gapEl.querySelector('.creative-history-gap-label');
    if (label) label.textContent = t('已折叠 {count} 条 · 继续滚动载入', { count });
  };

  const createPlaceholder = (sid, fromId, toId) => {
    const gapEl = documentRef.createElement('div');
    gapEl.className = 'creative-history-gap';
    gapEl.dataset.fromId = fromId;
    gapEl.dataset.toId = toId;
    gapEl.setAttribute('role', 'separator');
    const label = documentRef.createElement('span');
    label.className = 'creative-history-gap-label';
    gapEl.append(label);
    updatePlaceholderLabel(sid, gapEl);
    return gapEl;
  };

  // 收起上次跳转留下的「附近一页 + 折叠」，回到只有最新部分的状态。
  const collapseWindow = (sid) => {
    const gapEl = placeholder();
    if (!gapEl) return;
    const tailStart = indexOf(sid, gapEl.dataset.toId) + 1;
    let node = scrollEl.firstChild;
    while (node && node !== gapEl) {
      const next = node.nextSibling;
      try { ui.cleanupRichTextMounts?.(node); } catch {}
      node.remove();
      node = next;
    }
    gapEl.remove();
    if (tailStart > 0) renderState.set(sid, { start: tailStart });
    ui.refreshRpFloorMarkers?.();
  };

  // 目标还没加载进内存时，往前一块块读进来（只读数据，不渲染）；已渲染起点随之后移。
  const ensureLoaded = async (sid, id) => {
    let index = indexOf(sid, id);
    let guard = 0;
    while (index < 0 && chatStore.hasOlderMessages?.(sid) && guard < 512) {
      guard += 1;
      const older = await chatStore.loadOlderMessages(sid, '', { partCount: 1 });
      if (!isCurrent(sid)) return -1;
      if (!older?.length) break;
      const state = renderState.get(sid) || { start: 0 };
      renderState.set(sid, { ...state, start: (Number(state.start) || 0) + older.length });
      index = indexOf(sid, id);
    }
    return index;
  };

  // 写作气泡通常很大，跳转只平滑滑过去、不加强调特效；滑动期间暂停补折叠区，免得插入内容让落点偏掉
  let suppressFillUntil = 0;
  const flushAround = (id) => {
    const wrappers = [...scrollEl.querySelectorAll('.QQ_chat_mymsg[data-msg-id], .QQ_chat_charmsg[data-msg-id]')];
    const k = wrappers.findIndex(el => el.dataset.msgId === id);
    if (k < 0) return;
    try { flushLazyRich(wrappers.slice(Math.max(0, k - 2), k + 2)); } catch (err) { logger?.debug?.('creative history lazy flush failed', err); }
  };
  const focus = (id) => {
    flushAround(id);
    suppressFillUntil = Date.now() + 1000;
    const done = ui.scrollToMessage?.(id, { smooth: true, focus: false });
    setTimeout(() => { suppressFillUntil = 0; fillGap(); }, 1050);
    return done;
  };

  const jumpToMessage = async (sessionId, messageId) => {
    const sid = String(sessionId || '').trim();
    const id = String(messageId || '').trim();
    if (!sid || !id || !isCurrent(sid)) return false;
    if (scrollEl.querySelector(`[data-msg-id="${CSS.escape(id)}"]`) && focus(id)) return true;
    const targetIndex = await ensureLoaded(sid, id);
    if (!isCurrent(sid) || targetIndex < 0) return false;
    collapseWindow(sid);
    const renderedStart = Number(renderState.get(sid)?.start) || 0;
    const plan = planHistoryJump({ targetIndex, renderedStart });
    const messages = messagesOf(sid);
    if (plan.kind === 'extend') {
      ui.prependHistory?.(render(sid, messages.slice(plan.from, plan.to + 1)));
      renderState.set(sid, { start: plan.from });
    } else if (plan.kind === 'window') {
      const gapEl = createPlaceholder(sid, messages[plan.gapFrom].id, messages[plan.gapTo].id);
      scrollEl.insertBefore(gapEl, scrollEl.firstChild);
      ui.insertHistoryBefore?.(gapEl, render(sid, messages.slice(plan.from, plan.to + 1)));
      renderState.set(sid, { start: plan.from });
    }
    onMessagesRendered(sid);
    return Boolean(focus(id));
  };

  // 滚到折叠占位附近时补一页：从上方接近就往下补，从下方（最新部分）接近就往上补并保持画面不跳。
  let filling = false;
  const fillGap = () => {
    const gapEl = placeholder();
    const sid = String(getCurrentSessionId() || '').trim();
    if (!gapEl || !sid || filling || Date.now() < suppressFillUntil) return;
    const view = scrollEl.getBoundingClientRect();
    const rect = gapEl.getBoundingClientRect();
    const margin = Math.max(240, view.height * 0.5);
    const nearTop = rect.top < view.bottom + margin && rect.top >= view.top - 4;
    const nearBottom = !nearTop && rect.bottom > view.top - margin && rect.bottom <= view.bottom + 4;
    if (!nearTop && !nearBottom) return;
    const messages = messagesOf(sid);
    const from = indexOf(sid, gapEl.dataset.fromId);
    const to = indexOf(sid, gapEl.dataset.toId);
    if (from < 0 || to < from) {
      // 折叠范围里的消息被删掉等情况：收起回到最新部分
      collapseWindow(sid);
      return;
    }
    filling = true;
    try {
      if (nearTop) {
        const end = Math.min(to, from + HISTORY_WINDOW_PAGE - 1);
        ui.insertHistoryBefore?.(gapEl, render(sid, messages.slice(from, end + 1)));
        if (end >= to) gapEl.remove();
        else gapEl.dataset.fromId = messages[end + 1].id;
      } else {
        const begin = Math.max(from, to - HISTORY_WINDOW_PAGE + 1);
        ui.insertHistoryBefore?.(gapEl.nextSibling, render(sid, messages.slice(begin, to + 1)), { keepViewport: true });
        if (begin <= from) gapEl.remove();
        else gapEl.dataset.toId = messages[begin - 1].id;
      }
      if (gapEl.isConnected) updatePlaceholderLabel(sid, gapEl);
      onMessagesRendered(sid);
    } catch (err) {
      logger?.debug?.('creative history gap fill failed', err);
    } finally {
      filling = false;
    }
  };

  let raf = 0;
  const onScroll = () => {
    if (raf || !placeholder()) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      fillGap();
    });
  };
  scrollEl.addEventListener('scroll', onScroll, { passive: true });

  return {
    jumpToMessage,
    fillGap,
    hasCollapsedHistory: () => Boolean(placeholder()),
    destroy() {
      scrollEl.removeEventListener('scroll', onScroll);
    },
  };
};
