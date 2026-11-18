// 女仆对话历史（女仆设置 → 历史）：文字回合一条一项；同一次通话的字幕与任务结果合成一项，按说话先后排列。
// 结果卡片照原样显示。只读；「再来一次」交给调用方（执行前复核能力开关），新卡排在同一项下，不改历史里的旧卡。
import { t } from '../i18n/index.js';
import { renderMaidMarkdownHtml } from './maid-markdown-utils.js';
import { renderMaidResultCard } from './maid-result-card-dom.js';
import { normalizeMaidResultCards } from '../agent/maid-result-cards.js';

const PAGE_SIZE = 30;
const STYLE_ID = 'maid-history-style';
const trim = value => String(value ?? '').trim();

const MAID_HISTORY_STYLE = `
.mh { display: grid; gap: 12px; min-width: 0; }
.mh-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.mh-toolbar h3 { margin: 0; font-size: 16px; }
.mh-count { font-size: 12px; color: var(--app-text-secondary, #64748b); }
.mh-search { flex: 1 1 200px; min-width: 0; box-sizing: border-box; padding: 8px 12px; border: 1px solid var(--app-border-default, #cbd5e1); border-radius: 12px; background: var(--app-surface-card, #fff); color: var(--app-text-primary, #0f172a); font: inherit; font-size: 14px; }
.mh-day { margin: 8px 0 0; font-size: 12.5px; font-weight: 800; color: var(--app-text-secondary, #475569); }
.mh-entry { display: grid; gap: 8px; padding: 12px 14px; border: 1px solid var(--app-border-default, #e2e8f0); border-radius: 14px; background: var(--app-surface-card, #fff); min-width: 0; }
.mh-meta { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 12px; color: var(--app-text-muted, #94a3b8); font-variant-numeric: tabular-nums; }
.mh-tag { display: inline-flex; align-items: center; min-height: 18px; padding: 0 7px; border-radius: 6px; background: var(--app-surface-subtle, #f1f5f9); color: var(--app-text-secondary, #64748b); font-size: 11px; font-weight: 700; }
.mh-tag.is-off { color: var(--app-warning-text, #b45309); background: color-mix(in srgb, var(--app-warning-text, #b45309) 10%, transparent); }
.mh-user { justify-self: end; max-width: 88%; padding: 7px 11px; border-radius: 12px 12px 4px 12px; background: color-mix(in srgb, var(--app-accent-primary, #2563eb) 10%, transparent); color: var(--app-text-primary, #0f172a); font-size: 13.5px; white-space: pre-wrap; overflow-wrap: anywhere; }
.mh-reply { font-size: 13.5px; line-height: 1.65; color: var(--app-text-primary, #0f172a); overflow-wrap: anywhere; }
.mh-reply p { margin: 0 0 6px; }
.mh-reply p:last-child { margin-bottom: 0; }
.mh-task { font-size: 12px; font-weight: 700; color: var(--app-text-secondary, #475569); }
.mh-cards { display: grid; gap: 8px; }
.mh-empty { margin: 0; padding: 28px 16px; border: 1px dashed var(--app-border-default, #cbd5e1); border-radius: 14px; text-align: center; font-size: 13px; color: var(--app-text-secondary, #64748b); }
.mh-pager { justify-self: center; display: flex; gap: 8px; }
.mh-more, .mh-less { min-height: 32px; padding: 0 14px; border: 1px solid var(--app-border-default, #cbd5e1); border-radius: 999px; background: transparent; color: var(--app-text-secondary, #475569); font: inherit; font-size: 13px; font-weight: 700; cursor: pointer; }
.mh-more:hover, .mh-less:hover { background: var(--app-surface-hover, #f1f5f9); }
.mh-entry.is-hidden { border-style: dashed; }
.mh-entry.is-hidden > :not(.mh-meta):not(.mh-actions) { opacity: .55; }
.mh-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.mh-act { min-height: 26px; padding: 0 10px; border: 1px solid var(--app-border-default, #cbd5e1); border-radius: 999px; background: var(--app-surface-card, #fff); color: var(--app-text-secondary, #475569); font: inherit; font-size: 12px; font-weight: 700; cursor: pointer; }
.mh-act:hover:not(:disabled) { background: var(--app-surface-hover, #f1f5f9); color: var(--app-text-primary, #0f172a); }
.mh-act:disabled { opacity: .5; cursor: default; }
.mh-act.is-armed { border-color: var(--app-danger-text, #dc2626); color: var(--app-danger-text, #dc2626); }
.mh-act-warning { flex-basis: 100%; font-size: 12px; color: var(--app-warning-text, #b45309); }
`;

export const ensureMaidHistoryStyle = (documentRef) => {
  if (!documentRef?.head || documentRef.getElementById?.(STYLE_ID)) return;
  const style = documentRef.createElement('style');
  style.id = STYLE_ID;
  style.textContent = MAID_HISTORY_STYLE;
  documentRef.head.appendChild(style);
};

const callIdOf = turn => trim(turn?.context?.realtimeCallId || turn?.context?.voiceCallId);

/** 回合 → 历史项（新的在前）：通话以第一句的时间排序，项内按说话先后。 */
export const groupMaidHistoryEntries = (turns = []) => {
  const entries = [];
  const calls = new Map();
  (Array.isArray(turns) ? turns : []).slice().sort((a, b) => (Number(a?.at) || 0) - (Number(b?.at) || 0)).forEach((turn) => {
    const callId = callIdOf(turn);
    if (!callId) {
      entries.push({ key: `turn:${trim(turn?.id)}`, kind: 'turn', at: Number(turn?.at) || 0, turns: [turn] });
      return;
    }
    let entry = calls.get(callId);
    if (!entry) {
      entry = { key: `call:${callId}`, kind: 'call', at: Number(turn?.at) || 0, turns: [] };
      calls.set(callId, entry);
      entries.push(entry);
    }
    entry.turns.push(turn);
  });
  return entries.reverse();
};

const entryText = entry => entry.turns.map(turn => `${trim(turn.input)} ${trim(turn.message)} ${trim(turn.context?.voiceRequestText)}`).join(' ').toLowerCase();

const formatTime = at => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
export const maidHistoryDayLabel = (at, now = new Date()) => {
  const date = new Date(at);
  const days = Math.round((new Date(now.toDateString()) - new Date(date.toDateString())) / 86400000);
  if (days === 0) return t('今天');
  if (days === 1) return t('昨天');
  return date.toLocaleDateString();
};

/**
 * 一项历史（时间与标签、你说的话、回复、结果卡片）的渲染，历史面板与女仆输入条的「前几轮」共用。
 * onCardAction(payload, cardsKey)：结果卡片动作（如「再来一次」）；extraCardsFor(cardsKey)：追加在该组卡片后的新卡。
 */
export const createMaidHistoryEntryRenderer = ({ documentRef = globalThis.document, onCardAction = null, extraCardsFor = () => [], roundActions = null, onRoundChanged = null } = {}) => {
  const node = (tag, className = '', text = '') => {
    const el = documentRef.createElement(tag);
    if (className) el.className = className;
    if (text) el.textContent = text;
    return el;
  };
  const userText = (tag, className, text) => {
    const el = node(tag, className, text);
    el.dataset.i18nSkip = '';
    return el;
  };
  const appendCards = (container, entryKey, cards) => {
    const all = [...normalizeMaidResultCards(cards), ...(extraCardsFor(entryKey) || [])];
    if (!all.length) return;
    const holder = node('div', 'mh-cards');
    all.forEach((card) => {
      const cardEl = renderMaidResultCard(documentRef, card, {
        onAction: typeof onCardAction === 'function' ? payload => onCardAction(payload, entryKey) : null,
        // 历史里的选项提问只显示，不再作答（要回答直接对女仆说）
        answerable: false,
      });
      if (cardEl) holder.appendChild(cardEl);
    });
    container.appendChild(holder);
  };
  const appendReply = (container, text) => {
    if (!trim(text)) return;
    const reply = node('div', 'mh-reply');
    reply.dataset.i18nSkip = '';
    reply.innerHTML = renderMaidMarkdownHtml(text);
    container.appendChild(reply);
  };
  // 按轮管理的按钮（ROADMAP 29-③）：删除、重新回答要点第二次才执行，第一次点时显示这一轮改过什么
  const appendRoundActions = (article, entry) => {
    const actions = typeof roundActions?.actionsFor === 'function' ? roundActions.actionsFor(entry) : [];
    if (!actions.length) return;
    const row = node('div', 'mh-actions');
    let warningEl = null;
    actions.forEach((action) => {
      const button = node('button', 'mh-act', action.label);
      button.type = 'button';
      button.dataset.roundAction = action.id;
      button.disabled = action.disabled === true;
      if (action.title) button.title = action.title;
      button.addEventListener('click', async (event) => {
        event?.preventDefault?.();
        event?.stopPropagation?.();
        if (button.disabled) return;
        if (action.confirmLabel && button.dataset.armed !== '1') {
          button.dataset.armed = '1';
          button.classList?.add?.('is-armed');
          button.textContent = action.confirmLabel;
          if (action.warning && !warningEl) {
            warningEl = node('span', 'mh-act-warning', action.warning);
            row.appendChild(warningEl);
          }
          return;
        }
        button.disabled = true;
        let changed = false;
        try { changed = await roundActions.run(entry, action.id); } catch {}
        if (changed) onRoundChanged?.();
        else button.disabled = false;
      });
      row.appendChild(button);
    });
    article.appendChild(row);
  };
  const renderEntry = (entry) => {
    const article = node('article', 'mh-entry');
    article.dataset.key = entry.key;
    const hidden = entry.turns.every(turn => turn?.hiddenFromMaid === true);
    if (hidden) article.className = 'mh-entry is-hidden';
    const meta = node('div', 'mh-meta');
    const last = entry.turns[entry.turns.length - 1];
    const start = formatTime(entry.at), end = formatTime(Number(last.at) || entry.at);
    meta.appendChild(node('time', '', entry.kind === 'call' && end !== start ? `${start}–${end}` : start));
    if (entry.kind === 'call') meta.appendChild(node('span', 'mh-tag', t('语音通话')));
    if (entry.kind === 'turn' && ['failed', 'cancelled'].includes(trim(last.status))) {
      meta.appendChild(node('span', 'mh-tag is-off', trim(last.status) === 'cancelled' ? t('已终止') : t('未完成')));
    }
    if (hidden) meta.appendChild(node('span', 'mh-tag is-off', t('女仆看不到')));
    article.appendChild(meta);
    entry.turns.forEach((turn) => {
      const caption = turn.responseType === 'realtime';
      // 通话里的任务结果：注明交办的是什么
      if (!caption && entry.kind === 'call' && trim(turn.context?.voiceRequestText)) {
        article.appendChild(userText('div', 'mh-task', `${t('任务')}：${trim(turn.context.voiceRequestText)}`));
      }
      if (trim(turn.input)) article.appendChild(userText('div', 'mh-user', trim(turn.input)));
      appendReply(article, turn.message);
      if (Array.isArray(turn.cards) && turn.cards.length) appendCards(article, `${entry.key}:${trim(turn.id)}`, turn.cards);
    });
    appendRoundActions(article, entry);
    return article;
  };
  return renderEntry;
};

export const createMaidHistoryPanel = ({ store, documentRef = globalThis.document, onCardAction = null, roundActions = null } = {}) => {
  let root = null, list = null, countEl = null, search = null;
  let shown = PAGE_SIZE;
  const extraCards = new Map(); // 历史项 key → 「再来一次」追加的新卡
  const renderEntry = createMaidHistoryEntryRenderer({
    documentRef,
    roundActions,
    onRoundChanged: () => render(),
    extraCardsFor: key => extraCards.get(key) || [],
    onCardAction: typeof onCardAction === 'function' ? async (payload, entryKey) => {
      const outcome = await onCardAction(payload);
      if (!outcome?.card) return;
      extraCards.set(entryKey, [...(extraCards.get(entryKey) || []), outcome.card].slice(-4));
      render();
    } : null,
  });
  const node = (tag, className = '', text = '') => {
    const el = documentRef.createElement(tag);
    if (className) el.className = className;
    if (text) el.textContent = text;
    return el;
  };
  const render = () => {
    if (!list) return;
    let entries = [];
    try { entries = groupMaidHistoryEntries(store?.listHistoryTurns?.() || []); } catch {}
    const query = trim(search?.value).toLowerCase();
    const matched = query ? entries.filter(entry => entryText(entry).includes(query)) : entries;
    if (countEl) countEl.textContent = t('{count} 项', { count: matched.length });
    list.replaceChildren();
    if (!matched.length) {
      list.appendChild(node('p', 'mh-empty', query ? t('没有找到相关的记录') : t('还没有和女仆的对话记录。')));
      return;
    }
    let day = '';
    matched.slice(0, shown).forEach((entry) => {
      const label = maidHistoryDayLabel(entry.at);
      if (label !== day) {
        day = label;
        list.appendChild(node('h4', 'mh-day', label));
      }
      list.appendChild(renderEntry(entry));
    });
    // 显示更早的记录一次多一页；显示过就能收起回第一页
    const pager = node('div', 'mh-pager');
    const pagerButton = (className, text, onClick) => {
      const button = node('button', className, text);
      button.type = 'button';
      button.addEventListener('click', onClick);
      pager.appendChild(button);
    };
    if (matched.length > shown) pagerButton('mh-more', t('显示更早的记录'), () => { shown += PAGE_SIZE; render(); });
    if (shown > PAGE_SIZE && matched.length > PAGE_SIZE) pagerButton('mh-less', t('收起'), () => { shown = PAGE_SIZE; render(); });
    if (pager.children.length) list.appendChild(pager);
  };
  return {
    mount(container) {
      root = container;
      ensureMaidHistoryStyle(documentRef);
      const wrap = node('div', 'mh');
      const toolbar = node('div', 'mh-toolbar');
      toolbar.appendChild(node('h3', '', t('对话历史')));
      countEl = node('span', 'mh-count');
      toolbar.appendChild(countEl);
      search = node('input', 'mh-search');
      search.type = 'search';
      search.placeholder = t('搜索对话');
      search.setAttribute('aria-label', t('搜索对话'));
      search.addEventListener('input', () => { shown = PAGE_SIZE; render(); });
      toolbar.appendChild(search);
      list = node('div', 'mh-list mh');
      wrap.appendChild(toolbar);
      wrap.appendChild(list);
      root.appendChild(wrap);
      render();
    },
    refresh: render,
  };
};
