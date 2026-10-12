// 创意写作刻度导航的数据层：为当前存档建立轻量索引（条号、角色、轮次、预览原料），
// 计算阅读位置，按记忆模式给出预览，并把刻度条接到聊天滚动区。只读，不改动聊天记录。
import { t } from '../../i18n/index.js';
import { readMemoryCoverageIntervals } from '../../memory/memory-coverage-utils.js';
import { createCreativeScrubber } from './creative-scrubber.js';

const SUMMARY_MATCH_BEFORE_MS = 5_000;
const SUMMARY_MATCH_AFTER_MS = 180_000;
const TABLE_ROWS_TTL_MS = 30_000;

const stripTags = value => String(value || '')
  .replace(/<details\b[\s\S]*?<\/details\s*>/gi, ' ')
  .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ')
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/<[^>]+>/g, ' ');

export { buildCreativeScrubberIndex } from './creative-thread-outline.js';

// 摘要模式的摘要只记生成时间：按「回复写入后不久生成」对上这一条回复。
export const matchSummaryForReply = (summaries = [], replyTs = 0) => {
  if (!replyTs) return null;
  let best = null;
  for (const item of Array.isArray(summaries) ? summaries : []) {
    const at = Number(item?.at) || 0;
    if (!at || at < replyTs - SUMMARY_MATCH_BEFORE_MS || at > replyTs + SUMMARY_MATCH_AFTER_MS) continue;
    if (!best || Math.abs(at - replyTs) < Math.abs(best.at - replyTs)) best = { at, text: String(item.text || '') };
  }
  return best?.text ? best : null;
};

// 表格模式：找覆盖这一轮的摘要行；单轮行优先，合并（滚动）摘要其次。
export const matchTableSummaryForTurn = (rows = [], turn = 0) => {
  if (!turn) return null;
  let best = null;
  for (const row of Array.isArray(rows) ? rows : []) {
    const text = String(row?.row_data?.summary ?? row?.row_data?.text ?? '').trim();
    if (!text) continue;
    const hit = readMemoryCoverageIntervals(row).find(({ from, to }) => turn >= from && turn <= to);
    if (!hit) continue;
    const span = hit.to - hit.from;
    if (!best || span < best.span) best = { text, from: hit.from, to: hit.to, span };
  }
  return best;
};

export const createCreativeScrubberRuntime = ({
  documentRef = document,
  hostEl = null,
  scrollEl = null,
  chatStore = null,
  outline = null,
  getSessionId = () => '',
  isActive = () => false,
  getBottomGuards = () => [],
  getMemoryMode = () => 'off',
  memoryTableStore = null,
  memoryTemplateStore = null,
  extractBodyText = null,
  jumpToMessage = async () => false,
  logger = null,
} = {}) => {
  if (!hostEl || !scrollEl || !chatStore || !outline) return null;

  let index = { entries: [], indexById: new Map() };
  let currentIndex = 0;
  // 跳转滑动期间锁定阅读位置为目标，免得滑过中间的消息时刻度窗口来回晃。
  // 解锁条件：跳转后至少 0.45 秒（过场淡出期间还没开始滚动）且滚动已停 0.18 秒；最长 2 秒保底。
  let jumpLock = null;
  let tableRows = { sid: '', at: 0, rows: [] };

  const sessionId = () => String(getSessionId() || '').trim();
  const entryAt = i => index.entries[i - 1] || null;

  const rebuildIndex = async () => {
    const sid = sessionId();
    if (!sid) return;
    const next = await outline.ensure(sid);
    if (next && sessionId() === sid) index = next;
  };

  // 阅读位置：滚动区里第一条明显露出来的消息；滚到底就是最后一条。
  const readCurrentIndex = () => {
    const total = index.entries.length;
    if (!total) return 0;
    if (scrollEl.scrollTop + scrollEl.clientHeight >= scrollEl.scrollHeight - 4) return total;
    const wrappers = scrollEl.querySelectorAll('.QQ_chat_mymsg[data-msg-id], .QQ_chat_charmsg[data-msg-id]');
    // 顶端只露出一小截（上一条的尾巴）不算正在读的那条：至少露出约 120px（或四分之一屏）
    const top = scrollEl.getBoundingClientRect().top + Math.min(120, scrollEl.clientHeight * 0.25);
    let lo = 0, hi = wrappers.length - 1, found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (wrappers[mid].getBoundingClientRect().bottom > top) { found = mid; hi = mid - 1; } else lo = mid + 1;
    }
    for (let k = Math.max(0, found); k >= 0 && k < wrappers.length; k += 1) {
      const i = index.indexById.get(String(wrappers[k].dataset.msgId || ''));
      if (i) return i;
    }
    return currentIndex || total;
  };

  const loadTableRows = async (sid) => {
    const now = Date.now();
    if (tableRows.sid === sid && now - tableRows.at < TABLE_ROWS_TTL_MS) return tableRows.rows;
    try {
      const templates = await memoryTemplateStore?.getTemplates?.({ is_default: true });
      const templateId = String((Array.isArray(templates) ? templates[0] : null)?.id || '').trim();
      const rows = templateId && memoryTableStore?.getMemories
        ? await memoryTableStore.getMemories({ template_id: templateId, scope: 'contact', contact_id: sid })
        : [];
      const list = (Array.isArray(rows) ? rows : [])
        .filter(row => row?.is_active !== false && String(row?.table_id || '').trim() === 'rp_summary');
      tableRows = { sid, at: now, rows: list };
    } catch (err) {
      logger?.debug?.('creative scrubber table rows failed', err);
      tableRows = { sid, at: now, rows: [] };
    }
    return tableRows.rows;
  };

  const bodyText = (entry) => {
    const live = chatStore.findMessage?.(entry.id, sessionId());
    const source = live ? String(live.content ?? live.raw ?? '') : entry.source;
    try {
      const result = extractBodyText?.(source);
      if (result?.ok && result.text) return result.text;
    } catch {}
    return stripTags(source);
  };

  const resolvePreview = async (i) => {
    const entry = entryAt(i);
    if (!entry) return null;
    const label = entry.turn ? `#${i} · ${t('第 {turn} 轮', { turn: entry.turn })}` : `#${i}`;
    if (entry.role === 'user') {
      const live = chatStore.findMessage?.(entry.id, sessionId());
      const text = live ? String(live.rawInput ?? live.raw ?? live.content ?? '') : entry.source;
      return { role: 'user', label, chip: t('你的输入'), text: stripTags(text) };
    }
    const mode = getMemoryMode();
    if (mode === 'summary') {
      const hit = matchSummaryForReply(chatStore.getSummaries?.(sessionId()), entry.ts);
      if (hit) return { role: 'ai', label, chip: t('摘要'), text: hit.text };
    } else if (mode === 'table') {
      const hit = matchTableSummaryForTurn(await loadTableRows(sessionId()), entry.turn);
      if (hit) {
        const chip = hit.from === hit.to ? t('表格摘要') : t('表格摘要 · 第 {from}–{to} 轮', { from: hit.from, to: hit.to });
        return { role: 'ai', label, chip, text: hit.text };
      }
    }
    return {
      role: 'ai',
      label,
      chip: mode === 'off' ? t('正文') : t('正文（这一轮还没有摘要）'),
      chipKind: 'body',
      text: bodyText(entry),
    };
  };

  const scrubber = createCreativeScrubber({
    documentRef,
    hostEl,
    scrollEl,
    getBottomGuards,
    getTotal: () => index.entries.length,
    getCurrent: () => currentIndex || index.entries.length,
    getRole: i => entryAt(i)?.role || '',
    resolvePreview,
    onJump: (i) => {
      const entry = entryAt(i);
      if (!entry) return;
      currentIndex = i;
      clearInterval(jumpLock?.timer);
      const startedAt = Date.now();
      jumpLock = { index: i, startedAt, lastScrollAt: startedAt, timer: setInterval(checkJumpLock, 60) };
      scrubber.refresh();
      Promise.resolve(jumpToMessage(sessionId(), entry.id)).catch(() => {});
    },
  });
  if (!scrubber) return null;

  function checkJumpLock() {
    if (!jumpLock) return;
    const now = Date.now();
    const settled = now - jumpLock.startedAt >= 450 && now - jumpLock.lastScrollAt >= 180;
    if (!settled && now - jumpLock.startedAt < 2000) return;
    clearInterval(jumpLock.timer);
    jumpLock = null;
    sync();
  }

  let syncRaf = 0;
  const sync = () => {
    if (syncRaf) return;
    syncRaf = requestAnimationFrame(async () => {
      syncRaf = 0;
      const active = Boolean(isActive());
      if (!active) {
        scrubber.setVisible(false);
        return;
      }
      await rebuildIndex();
      if (!isActive()) return;
      currentIndex = jumpLock ? jumpLock.index : readCurrentIndex();
      scrubber.setVisible(true);
      scrubber.refresh();
    });
  };

  const onScroll = () => {
    if (jumpLock) jumpLock.lastScrollAt = Date.now();
    if (!isActive()) return;
    scrubber.wake();
    sync();
  };
  scrollEl.addEventListener('scroll', onScroll, { passive: true });
  const mutationObserver = typeof MutationObserver === 'function' ? new MutationObserver(() => sync()) : null;
  mutationObserver?.observe(scrollEl, { childList: true });
  const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => scrubber.refresh({ force: true })) : null;
  resizeObserver?.observe(scrollEl);
  // 切换聊天/写作模式、进出聊天室时重新判断是否显示
  const stateObserver = typeof MutationObserver === 'function' ? new MutationObserver(() => sync()) : null;
  stateObserver?.observe(documentRef.body, { attributes: true, attributeFilter: ['data-ui-mode', 'data-rp-scrubber'] });
  stateObserver?.observe(hostEl, { attributes: true, attributeFilter: ['class'] });
  const invalidateMemoryRows = () => { tableRows = { sid: '', at: 0, rows: [] }; };
  const win = documentRef.defaultView;
  win?.addEventListener?.('memory-rows-updated', invalidateMemoryRows);

  return {
    sync,
    invalidateMemoryRows,
    destroy() {
      scrollEl.removeEventListener('scroll', onScroll);
      clearInterval(jumpLock?.timer);
      mutationObserver?.disconnect();
      resizeObserver?.disconnect();
      stateObserver?.disconnect();
      win?.removeEventListener?.('memory-rows-updated', invalidateMemoryRows);
      scrubber.destroy();
    },
  };
};
