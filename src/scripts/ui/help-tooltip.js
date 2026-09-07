// 渐进式说明浮层（data-help）：把常驻小字说明搬进 data-help 属性，按需浮现。
// 桌面：hover / 键盘 focus 出说明；手机：纯标题/标签点一下出、可点控件长按出（短按走原功能）。
// 全 app 复用：任何元素加 data-help="说明文字" 即可；可选 data-help-title="标题"、data-help-mode="tap|press"。

const ACTIONABLE_SELECTOR = [
  'button',
  'a[href]',
  'input',
  'select',
  'textarea',
  '[role="button"]',
  '[role="tab"]',
  '[role="switch"]',
  '[role="menuitem"]',
  '[role="checkbox"]',
  '[onclick]',
].join(',');

const LONG_PRESS_MS = 450;
const HOVER_DELAY_MS = 300;
const MOVE_CANCEL_PX = 10;
const EDGE_GAP = 8; // 浮层与视口边缘/锚点的最小间距

// 纯函数：判定 touch 场景下该元素用「点一下出」还是「长按出」。
// 显式 data-help-mode 优先；否则可交互控件=press（长按），普通标题/标签=tap（点一下）。
export const resolveHelpTrigger = (el) => {
  if (!el || typeof el.matches !== 'function') return 'tap';
  const mode = (el.getAttribute?.('data-help-mode') || '').trim().toLowerCase();
  if (mode === 'tap' || mode === 'press') return mode;
  try {
    if (el.matches(ACTIONABLE_SELECTOR)) return 'press';
  } catch { /* 无效选择器兜底 */ }
  return 'tap';
};

// 纯函数：计算浮层位置（优先下方，放不下翻到上方；水平居中并夹在视口内）。
export const computeTooltipPlacement = (anchorRect, tipSize, viewport, gap = EDGE_GAP) => {
  const vw = viewport?.width || 0;
  const vh = viewport?.height || 0;
  const tw = tipSize?.width || 0;
  const th = tipSize?.height || 0;
  let placement = 'bottom';
  let top = anchorRect.bottom + gap;
  if (top + th > vh - gap && anchorRect.top - gap - th >= gap) {
    top = anchorRect.top - gap - th;
    placement = 'top';
  }
  // 左对齐到锚点左边缘（标题文字起点）：整行 block 标签与窄 span 都自然贴着标题，不会漂到界面中间。
  let left = anchorRect.left;
  left = Math.max(gap, Math.min(left, vw - tw - gap));
  return { left, top, placement };
};

let inited = false;

export const initHelpTooltips = (options = {}) => {
  if (inited) return;
  const doc = options.document || (typeof document !== 'undefined' ? document : null);
  const win = options.window || (typeof window !== 'undefined' ? window : null);
  if (!doc || !win || !doc.body) return;
  inited = true;

  const tip = doc.createElement('div');
  tip.className = 'app-help-tip';
  tip.setAttribute('role', 'tooltip');
  tip.setAttribute('aria-hidden', 'true');
  tip.innerHTML = '<div class="app-help-tip__title"></div><div class="app-help-tip__body"></div>';
  doc.body.appendChild(tip);
  const titleEl = tip.querySelector('.app-help-tip__title');
  const bodyEl = tip.querySelector('.app-help-tip__body');

  let currentAnchor = null;
  let hoverTimer = null;
  let pressTimer = null;
  let pressStart = null; // {x,y,el}
  let suppressNextClick = false;

  const findTarget = (node) => (node && node.closest ? node.closest('[data-help]') : null);

  const show = (anchor) => {
    const text = anchor.getAttribute('data-help');
    if (!text) return;
    const title = anchor.getAttribute('data-help-title') || '';
    titleEl.textContent = title;
    titleEl.style.display = title ? '' : 'none';
    bodyEl.textContent = text;
    currentAnchor = anchor;
    tip.setAttribute('aria-hidden', 'false');
    tip.classList.add('is-visible');
    if (anchor.id || anchor.getAttribute('aria-describedby')) {
      // 已有 describedby 就不覆盖；否则临时关联，读屏可读
      if (!anchor.getAttribute('aria-describedby')) anchor.setAttribute('aria-describedby', 'app-help-tip');
    }
    tip.id = 'app-help-tip';
    // 先渲染再测量定位
    tip.style.left = '0px';
    tip.style.top = '0px';
    const anchorRect = anchor.getBoundingClientRect();
    const tipRect = tip.getBoundingClientRect();
    const { left, top, placement } = computeTooltipPlacement(
      anchorRect,
      { width: tipRect.width, height: tipRect.height },
      { width: win.innerWidth, height: win.innerHeight },
    );
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(top)}px`;
    tip.dataset.placement = placement;
  };

  const hide = () => {
    if (!currentAnchor) return;
    if (currentAnchor.getAttribute('aria-describedby') === 'app-help-tip') {
      currentAnchor.removeAttribute('aria-describedby');
    }
    currentAnchor = null;
    tip.setAttribute('aria-hidden', 'true');
    tip.classList.remove('is-visible');
  };

  const clearHover = () => { if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; } };
  const clearPress = () => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } pressStart = null; };

  // ---- 桌面：hover ----
  doc.addEventListener('pointerover', (e) => {
    if (e.pointerType && e.pointerType !== 'mouse') return;
    const target = findTarget(e.target);
    if (!target || target === currentAnchor) return;
    clearHover();
    hoverTimer = setTimeout(() => show(target), HOVER_DELAY_MS);
  });
  doc.addEventListener('pointerout', (e) => {
    if (e.pointerType && e.pointerType !== 'mouse') return;
    const target = findTarget(e.target);
    if (!target) return;
    // 移到浮层内部不算离开
    if (e.relatedTarget && (tip.contains(e.relatedTarget) || target.contains(e.relatedTarget))) return;
    clearHover();
    hide();
  });

  // ---- 键盘可达性：focus 出、blur 收 ----
  doc.addEventListener('focusin', (e) => {
    const target = findTarget(e.target);
    if (target) show(target);
  });
  doc.addEventListener('focusout', (e) => {
    const target = findTarget(e.target);
    if (target && target === currentAnchor) hide();
  });

  // ---- 手机：touch/pen ----
  doc.addEventListener('pointerdown', (e) => {
    // 点浮层外的空白 → 收起
    if (tip.contains(e.target)) return;
    const target = findTarget(e.target);
    if (!target) { hide(); return; }
    if (!e.pointerType || e.pointerType === 'mouse') return; // 鼠标交给 hover 逻辑
    const trigger = resolveHelpTrigger(target);
    pressStart = { x: e.clientX, y: e.clientY, el: target, trigger, toggled: false };
    if (trigger === 'press') {
      // 可点控件：长按出说明并吞掉随后的 click；短按放行原功能
      clearPress();
      pressTimer = setTimeout(() => {
        pressTimer = null;
        suppressNextClick = true;
        show(target);
        if (pressStart) pressStart.toggled = true;
      }, LONG_PRESS_MS);
    }
  }, true);

  doc.addEventListener('pointermove', (e) => {
    if (!pressStart) return;
    if (Math.abs(e.clientX - pressStart.x) > MOVE_CANCEL_PX ||
        Math.abs(e.clientY - pressStart.y) > MOVE_CANCEL_PX) {
      clearPress(); // 滑动=滚动，取消长按
    }
  }, true);

  doc.addEventListener('pointerup', (e) => {
    if (!pressStart) return;
    const { el, trigger, toggled } = pressStart;
    const moved = Math.abs(e.clientX - pressStart.x) > MOVE_CANCEL_PX ||
                  Math.abs(e.clientY - pressStart.y) > MOVE_CANCEL_PX;
    clearPress();
    if (moved) return;
    if (trigger === 'tap') {
      // 纯标题/标签：点一下 toggle
      // 说明点按只打开浮层，阻止 label 聚焦输入框或触发父级按钮。
      suppressNextClick = true;
      if (currentAnchor === el) hide();
      else show(el);
    }
    // trigger === 'press' 且未到长按时长：什么都不做，click 正常触发原功能
    void toggled;
  }, true);

  doc.addEventListener('pointercancel', () => { clearPress(); });

  // 说明触发后，吞掉那一次 click（capture 阶段）
  doc.addEventListener('click', (e) => {
    if (suppressNextClick) {
      suppressNextClick = false;
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);

  // 滚动/缩放/Esc/失焦 → 收起
  win.addEventListener('scroll', () => hide(), true);
  win.addEventListener('resize', () => hide());
  doc.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });

  return { show, hide };
};

export const __testables = { ACTIONABLE_SELECTOR, LONG_PRESS_MS, HOVER_DELAY_MS };
