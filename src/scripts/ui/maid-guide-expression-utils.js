export const MAID_GUIDE_EXPRESSION_SHEET_SRC = './assets/media/maid-guide-expression-sheet.webp';
// 半身构图：每格放大 1.45 倍、顶部留 3%，脸在 44–72px 的头像里够大，手势和道具大多还在框内。
// 放大后一格显示约 221 源像素，手机 3 倍屏 72px 正好 1:1，所以只用 320px/格的大表。
export const MAID_GUIDE_EXPRESSION_ZOOM = 1.45;
export const MAID_GUIDE_EXPRESSION_TOP = 0.03;
export const MAID_GUIDE_EXPRESSION_BACKGROUND = '#efedf7';

const EXPRESSION_GRID_SIZE = 4;

export const MAID_GUIDE_EXPRESSIONS = Object.freeze({
  welcome: Object.freeze({ row: 0, column: 0 }),
  bow: Object.freeze({ row: 0, column: 1 }),
  point: Object.freeze({ row: 0, column: 2 }),
  idea: Object.freeze({ row: 0, column: 3 }),
  thinking: Object.freeze({ row: 1, column: 0 }),
  explain: Object.freeze({ row: 1, column: 1 }),
  manual: Object.freeze({ row: 1, column: 2 }),
  clipboard: Object.freeze({ row: 1, column: 3 }),
  cheer: Object.freeze({ row: 2, column: 0 }),
  success: Object.freeze({ row: 2, column: 1 }),
  apology: Object.freeze({ row: 2, column: 2 }),
  listen: Object.freeze({ row: 2, column: 3 }),
  waiting: Object.freeze({ row: 3, column: 0 }),
  surprise: Object.freeze({ row: 3, column: 1 }),
  encourage: Object.freeze({ row: 3, column: 2 }),
  complete: Object.freeze({ row: 3, column: 3 }),
});

const trim = value => String(value ?? '').trim();

export const getMaidGuideExpression = (state = 'welcome') => {
  const key = Object.hasOwn(MAID_GUIDE_EXPRESSIONS, trim(state)) ? trim(state) : 'welcome';
  const cell = MAID_GUIDE_EXPRESSIONS[key];
  return { state: key, row: cell.row, column: cell.column };
};

export const resolveMaidGuideExpressionState = ({ phase = 'steps', step = null, index = 0 } = {}) => {
  const requested = trim(step?.expression);
  if (requested && Object.hasOwn(MAID_GUIDE_EXPRESSIONS, requested)) return requested;
  if (phase === 'done') return 'complete';
  if (step?.action === 'click') return 'point';
  if (step?.action === 'type') return 'clipboard';
  if (step?.action === 'wait-event') {
    return trim(step?.target) === 'chat-body' ? 'waiting' : 'listen';
  }
  return Number(index) > 0 ? 'explain' : 'welcome';
};

export const MAID_GUIDE_EXPRESSION_SHEET_CLASS = 'maid-guide-expression-sheet';

// 整张表用 <img> 画、由头像框裁出一格，不用 CSS 背景图：背景图只取表的一部分时，浏览器为了不渗进相邻格子
// 不走多级缩略图（mipmap），桌面 1–1.5 倍屏一次缩小 2.5–4 倍会出锯齿；整张 <img> 和贴图一样走高质量缩小。
export const applyMaidGuideExpression = (element = null, state = 'welcome') => {
  if (!element) return null;
  const expression = getMaidGuideExpression(state);
  element.classList?.add?.('maid-guide-expression');
  if (element.dataset) element.dataset.maidExpression = expression.state;
  if (element.style) {
    element.style.position = 'relative';
    element.style.overflow = 'hidden';
    element.style.backgroundColor = MAID_GUIDE_EXPRESSION_BACKGROUND;
    element.style.backgroundClip = 'padding-box';
  }
  let sheet = Array.from(element.children || [])
    .find(child => child?.classList?.contains?.(MAID_GUIDE_EXPRESSION_SHEET_CLASS)) || null;
  if (!sheet && element.ownerDocument?.createElement) {
    sheet = element.ownerDocument.createElement('img');
    sheet.className = MAID_GUIDE_EXPRESSION_SHEET_CLASS;
    sheet.alt = '';
    sheet.decoding = 'async';
    sheet.draggable = false;
    element.appendChild?.(sheet);
  }
  if (sheet) {
    const zoom = MAID_GUIDE_EXPRESSION_ZOOM;
    const percent = value => -Number((value * 100).toFixed(4));
    const left = percent(expression.column * zoom + (zoom - 1) / 2);
    const top = percent((expression.row + MAID_GUIDE_EXPRESSION_TOP) * zoom);
    sheet.src = MAID_GUIDE_EXPRESSION_SHEET_SRC;
    sheet.style.cssText = `position:absolute;left:${left}%;top:${top}%;`
      + `width:${EXPRESSION_GRID_SIZE * zoom * 100}%;height:${EXPRESSION_GRID_SIZE * zoom * 100}%;`
      + 'max-width:none;max-height:none;pointer-events:none;user-select:none;';
  }
  return expression;
};
