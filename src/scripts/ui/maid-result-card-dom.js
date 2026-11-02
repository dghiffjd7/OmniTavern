// 女仆结果卡片的渲染（数据与校验见 agent/maid-result-cards.js）：按种类画，卡片数据只经 textContent 写入。
// 文字回复区、语音托盘与对话历史共用；「再来一次」等动作交给调用方，由它在执行前复核能力开关。
import { t } from '../i18n/index.js';
import { normalizeMaidResultCard } from '../agent/maid-result-cards.js';

const STYLE_ID = 'maid-result-card-style';

const svg = body => `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${body}</svg>`;
const ICONS = Object.freeze({
  dice: svg('<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="3.5"/></g><g fill="currentColor"><circle cx="9" cy="9" r="1.2"/><circle cx="15" cy="15" r="1.2"/><circle cx="12" cy="12" r="1.2"/></g>'),
  draw: svg('<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4h10l-1 16H8z"/><path d="M10 4V2.5M14 4V2.5"/><path d="M10 9h4"/></g>'),
  choose: svg('<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/></g>'),
  reroll: svg('<g fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 5v6h-6"/></g>'),
});

// 六面骰画点数，其他面数直接写数字
const PIPS = {
  1: [[12, 12]], 2: [[8, 8], [16, 16]], 3: [[8, 8], [12, 12], [16, 16]], 4: [[8, 8], [16, 8], [8, 16], [16, 16]],
  5: [[8, 8], [16, 8], [12, 12], [8, 16], [16, 16]], 6: [[8, 7.5], [16, 7.5], [8, 12], [16, 12], [8, 16.5], [16, 16.5]],
};

const MAID_RESULT_CARD_STYLE = `
.mrcard { display: grid; gap: 10px; padding: 12px 14px; border: 1px solid var(--app-border-default, #e2e8f0); border-radius: 14px; background: var(--app-surface-card, #fff); color: var(--app-text-primary, #0f172a); }
.mrcard-head { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 700; }
.mrcard-icon { display: inline-flex; width: 26px; height: 26px; align-items: center; justify-content: center; border-radius: 8px; background: color-mix(in srgb, var(--app-accent-primary, #2563eb) 10%, transparent); color: var(--app-accent-primary, #2563eb); flex: 0 0 auto; }
.mrcard-icon svg { width: 16px; height: 16px; }
.mrcard-dice { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.mrcard-die { width: 40px; height: 40px; display: inline-flex; align-items: center; justify-content: center; border: 2px solid var(--app-accent-primary, #2563eb); border-radius: 10px; color: var(--app-accent-primary, #2563eb); font-size: 17px; font-weight: 800; font-variant-numeric: tabular-nums; }
.mrcard-die svg { width: 30px; height: 30px; }
.mrcard-total { font-size: 13px; color: var(--app-text-secondary, #475569); }
.mrcard-total strong { color: var(--app-text-primary, #0f172a); font-size: 15px; }
.mrcard-options { display: flex; flex-wrap: wrap; gap: 6px; margin: 0; padding: 0; list-style: none; }
.mrcard-option { display: inline-flex; align-items: center; gap: 6px; min-height: 26px; padding: 2px 10px; border: 1px solid var(--app-border-default, #e2e8f0); border-radius: 999px; font-size: 13px; color: var(--app-text-secondary, #475569); overflow-wrap: anywhere; }
.mrcard-option.is-picked { border-color: var(--app-accent-primary, #2563eb); background: color-mix(in srgb, var(--app-accent-primary, #2563eb) 12%, transparent); color: var(--app-text-primary, #0f172a); font-weight: 700; }
.mrcard-order { display: inline-flex; min-width: 18px; height: 18px; align-items: center; justify-content: center; border-radius: 999px; background: var(--app-accent-primary, #2563eb); color: var(--app-text-on-accent, #fff); font-size: 11px; font-weight: 800; }
.mrcard-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.mrcard-note { font-size: 11.5px; color: var(--app-text-muted, #94a3b8); }
.mrcard-action { display: inline-flex; align-items: center; gap: 5px; min-height: 28px; padding: 0 10px; border: 1px solid var(--app-border-default, #e2e8f0); border-radius: 999px; background: transparent; color: var(--app-text-secondary, #475569); font: inherit; font-size: 12.5px; font-weight: 700; cursor: pointer; }
.mrcard-action:hover { background: var(--app-surface-hover, #f1f5f9); color: var(--app-text-primary, #0f172a); }
.mrcard-action:disabled { opacity: .5; cursor: default; }
.mrcard-action svg { width: 14px; height: 14px; }
.mrcard.is-rolling .mrcard-die, .mrcard.is-rolling .mrcard-option.is-picked { animation: mrcard-roll 520ms cubic-bezier(.22, 1, .36, 1) both; }
@keyframes mrcard-roll { 0% { transform: rotate(-28deg) scale(.6); opacity: 0; } 60% { transform: rotate(8deg) scale(1.06); opacity: 1; } 100% { transform: none; } }
body[data-reduced-motion='on'] .mrcard * { animation: none !important; }
@media (prefers-reduced-motion: reduce) { .mrcard * { animation: none !important; } }
`;

export const injectMaidResultCardStyle = (documentRef) => {
  if (!documentRef?.head || documentRef.getElementById?.(STYLE_ID)) return;
  const style = documentRef.createElement?.('style');
  if (!style) return;
  style.id = STYLE_ID;
  style.textContent = MAID_RESULT_CARD_STYLE;
  documentRef.head.appendChild(style);
};

const node = (doc, tag, className = '', text = '') => {
  const el = doc.createElement(tag);
  if (className) el.className = className;
  if (text) el.textContent = text;
  return el;
};

const dieNode = (doc, value, sides) => {
  const die = node(doc, 'span', 'mrcard-die');
  die.setAttribute?.('aria-label', String(value));
  if (sides === 6) die.innerHTML = svg(PIPS[value].map(([cx, cy]) => `<circle cx="${cx}" cy="${cy}" r="1.9" fill="currentColor"/>`).join(''));
  else die.textContent = String(value);
  return die;
};

const randomTitle = data => (data.mode === 'dice'
  ? t('掷 {count} 个 {sides} 面骰', { count: data.rolls.length, sides: data.sides })
  : data.mode === 'draw' ? t('抽签') : t('帮你选'));

const renderRandomBody = (doc, data) => {
  if (data.mode === 'dice') {
    const body = node(doc, 'div', 'mrcard-body');
    const dice = node(doc, 'div', 'mrcard-dice');
    data.rolls.forEach(value => dice.appendChild(dieNode(doc, value, data.sides)));
    body.appendChild(dice);
    if (data.rolls.length > 1) {
      const total = node(doc, 'div', 'mrcard-total', `${t('合计')} `);
      total.appendChild(node(doc, 'strong', '', String(data.total)));
      body.appendChild(total);
    }
    return body;
  }
  // 候选项全部列出，抽中的高亮；抽多个时标出先后
  const list = node(doc, 'ul', 'mrcard-options');
  data.options.forEach((option) => {
    const order = data.picked.indexOf(option);
    const item = node(doc, 'li', `mrcard-option${order >= 0 ? ' is-picked' : ''}`);
    if (order >= 0 && data.picked.length > 1) item.appendChild(node(doc, 'span', 'mrcard-order', String(order + 1)));
    item.appendChild(node(doc, 'span', '', option));
    item.dataset.i18nSkip = '';
    list.appendChild(item);
  });
  return list;
};

/**
 * 画一张结果卡；数据不合规时返回 null。
 * onAction({ action: 'reroll', card }) 返回 Promise 时，按钮在等待期间禁用。
 */
export const renderMaidResultCard = (documentRef, rawCard, { animate = false, onAction = null } = {}) => {
  const card = normalizeMaidResultCard(rawCard);
  if (!card || !documentRef?.createElement) return null;
  injectMaidResultCardStyle(documentRef);
  const root = node(documentRef, 'div', `mrcard is-${card.type}${animate ? ' is-rolling' : ''}`);
  root.dataset.cardId = card.id;
  const head = node(documentRef, 'div', 'mrcard-head');
  const icon = node(documentRef, 'span', 'mrcard-icon');
  icon.innerHTML = ICONS[card.data.mode] || ICONS.dice;
  head.appendChild(icon);
  head.appendChild(node(documentRef, 'span', 'mrcard-title', randomTitle(card.data)));
  const foot = node(documentRef, 'div', 'mrcard-foot');
  foot.appendChild(node(documentRef, 'span', 'mrcard-note', t('由 APP 随机生成')));
  if (typeof onAction === 'function') {
    const button = node(documentRef, 'button', 'mrcard-action');
    button.type = 'button';
    button.innerHTML = ICONS.reroll;
    button.appendChild(node(documentRef, 'span', '', t('再来一次')));
    button.addEventListener?.('click', async (event) => {
      event?.preventDefault?.();
      event?.stopPropagation?.();
      if (button.disabled) return;
      button.disabled = true;
      try { await onAction({ action: 'reroll', card }); } finally { button.disabled = false; }
    });
    foot.appendChild(button);
  }
  [head, renderRandomBody(documentRef, card.data), foot].forEach(part => root.appendChild(part));
  if (animate) root.addEventListener?.('animationend', () => root.classList?.remove?.('is-rolling'), { once: true });
  return root;
};
