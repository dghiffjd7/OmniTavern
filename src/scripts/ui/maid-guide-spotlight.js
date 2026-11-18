import {
  applyMaidGuideExpression,
  resolveMaidGuideExpressionState,
} from './maid-guide-expression-utils.js';

const STYLE_ID = 'maid-guide-spotlight-style';
const CARD_WIDTH = 384;
const CARD_ESTIMATED_HEIGHT = 236;
const MOBILE_BREAKPOINT = 520;
const VIEWPORT_PAD = 16;
const MOBILE_PAD = 12;
const MOBILE_TOP_PAD = 62;
const HOLE_PAD = 10;
const CARD_TARGET_GAP = 16;
const CARD_MIN_USABLE_HEIGHT = 132;
const TARGET_RESOLVE_GRACE_MS = 1000;
const TARGET_RESOLVE_RETRY_MS = 100;
const GEOMETRY_FOLLOW_TIME_CONSTANT_MS = 90;
const GEOMETRY_SETTLE_THRESHOLD = 0.5;
const GEOMETRY_STABLE_FRAME_COUNT = 3;
const GEOMETRY_DEFAULT_FRAME_MS = 1000 / 60;
const GEOMETRY_MAX_FRAME_MS = 32;

const clamp = (value, min, max) => Math.min(Math.max(Number(value) || 0, min), Math.max(min, max));

const rectValue = (rect, key, fallback = 0) => {
  const value = Number(rect?.[key]);
  return Number.isFinite(value) ? value : fallback;
};

const hasRectChanged = (previous = null, next = null, threshold = 0.5) => (
  ['left', 'top', 'width', 'height'].some(
    key => Math.abs(rectValue(next, key) - rectValue(previous, key)) > threshold,
  )
);

export const advanceMaidSpotlightBox = ({
  current = null,
  target = null,
  deltaMs = GEOMETRY_DEFAULT_FRAME_MS,
  reducedMotion = false,
} = {}) => {
  const destination = {
    left: rectValue(target, 'left'),
    top: rectValue(target, 'top'),
    width: Math.max(0, rectValue(target, 'width')),
    height: Math.max(0, rectValue(target, 'height')),
  };
  if (!current || reducedMotion) return { box: destination, settled: true };
  const elapsed = Number(deltaMs);
  const safeDelta = Number.isFinite(elapsed) && elapsed > 0
    ? Math.min(GEOMETRY_MAX_FRAME_MS, elapsed)
    : GEOMETRY_DEFAULT_FRAME_MS;
  const alpha = 1 - Math.exp(-safeDelta / GEOMETRY_FOLLOW_TIME_CONSTANT_MS);
  let settled = true;
  const box = {};
  ['left', 'top', 'width', 'height'].forEach((key) => {
    const from = rectValue(current, key);
    const to = destination[key];
    const next = from + (to - from) * alpha;
    if (Math.abs(to - next) <= GEOMETRY_SETTLE_THRESHOLD) {
      box[key] = to;
      return;
    }
    settled = false;
    box[key] = next;
  });
  return { box, settled };
};

export const resolveMaidSpotlightMaskGeometry = ({
  viewport = {},
  hole = {},
  devicePixelRatio = 1,
} = {}) => {
  const w = Math.max(0, Number(viewport.w || viewport.width || 0) || 0);
  const h = Math.max(0, Number(viewport.h || viewport.height || 0) || 0);
  const sampledRatio = Number(devicePixelRatio);
  const ratio = Number.isFinite(sampledRatio) && sampledRatio > 0 ? sampledRatio : 1;
  const snapEdge = (value, max) => clamp(
    Math.round(clamp(value, 0, max) * ratio) / ratio,
    0,
    max,
  );
  const rawLeft = rectValue(hole, 'left');
  const rawTop = rectValue(hole, 'top');
  const left = snapEdge(rawLeft, w);
  const top = snapEdge(rawTop, h);
  const right = Math.max(left, snapEdge(rawLeft + Math.max(0, rectValue(hole, 'width')), w));
  const bottom = Math.max(top, snapEdge(rawTop + Math.max(0, rectValue(hole, 'height')), h));
  const snappedHole = {
    left,
    top,
    width: right - left,
    height: bottom - top,
  };
  return {
    hole: snappedHole,
    panes: {
      top: { left: 0, top: 0, width: w, height: top },
      bottom: { left: 0, top: bottom, width: w, height: Math.max(0, h - bottom) },
      left: { left: 0, top, width: left, height: bottom - top },
      right: { left: right, top, width: Math.max(0, w - right), height: bottom - top },
    },
  };
};

export const isMaidGuideMotionReduced = (
  documentRef = globalThis?.document || null,
  matchMediaFn = globalThis?.matchMedia || null,
) => {
  if (documentRef?.body?.dataset?.reducedMotion === 'on') return true;
  try {
    return typeof matchMediaFn === 'function' && matchMediaFn('(prefers-reduced-motion: reduce)')?.matches === true;
  } catch {
    return false;
  }
};

export const isMaidGuideTargetOutsideViewport = ({
  rect = null,
  viewport = {},
  margin = 8,
} = {}) => {
  if (!rect) return false;
  const w = Math.max(0, Number(viewport.w || viewport.width || 0) || 0);
  const h = Math.max(0, Number(viewport.h || viewport.height || 0) || 0);
  if (!w || !h) return false;
  const left = rectValue(rect, 'left', rectValue(rect, 'x'));
  const top = rectValue(rect, 'top', rectValue(rect, 'y'));
  const right = rectValue(rect, 'right', left + Math.max(0, rectValue(rect, 'width')));
  const bottom = rectValue(rect, 'bottom', top + Math.max(0, rectValue(rect, 'height')));
  const safeMargin = Math.max(0, Number(margin) || 0);
  return right <= safeMargin || left >= w - safeMargin || bottom <= safeMargin || top >= h - safeMargin;
};

export const calculateMaidSpotlightLayout = ({
  viewport = {},
  targetRect = null,
  cardSize = {},
  placement = '',
  safeBottom = 0,
} = {}) => {
  const w = Math.max(1, Number(viewport.w || viewport.width || 0) || 1);
  const h = Math.max(1, Number(viewport.h || viewport.height || 0) || 1);
  const mobile = w < MOBILE_BREAKPOINT;
  const bottomInset = Math.max(0, Number(safeBottom) || 0);
  const cardWidth = mobile
    ? Math.max(1, w - MOBILE_PAD * 2)
    : Math.min(Number(cardSize.width || CARD_WIDTH) || CARD_WIDTH, Math.max(1, w - VIEWPORT_PAD * 2));
  const maxCardHeight = mobile
    ? Math.max(1, h - MOBILE_TOP_PAD - MOBILE_PAD - bottomInset)
    : Math.max(1, h - VIEWPORT_PAD * 2);
  const cardHeight = Math.min(
    Number(cardSize.height || CARD_ESTIMATED_HEIGHT) || CARD_ESTIMATED_HEIGHT,
    maxCardHeight,
  );

  let hole = null;
  if (targetRect) {
    const left = rectValue(targetRect, 'left', rectValue(targetRect, 'x'));
    const top = rectValue(targetRect, 'top', rectValue(targetRect, 'y'));
    const width = Math.max(0, rectValue(targetRect, 'width'));
    const height = Math.max(0, rectValue(targetRect, 'height'));
    const holeLeft = clamp(left - HOLE_PAD, 0, w);
    const holeTop = clamp(top - HOLE_PAD, 0, h);
    const holeRight = clamp(left + width + HOLE_PAD, holeLeft, w);
    const holeBottom = clamp(top + height + HOLE_PAD, holeTop, h);
    hole = {
      left: holeLeft,
      top: holeTop,
      width: holeRight - holeLeft,
      height: holeBottom - holeTop,
    };
  }

  if (mobile) {
    const topBound = Math.min(MOBILE_TOP_PAD, Math.max(MOBILE_PAD, h - MOBILE_PAD - bottomInset));
    const bottomBound = Math.max(topBound, h - MOBILE_PAD - bottomInset);
    const topCard = {
      left: MOBILE_PAD,
      top: Math.min(topBound, Math.max(MOBILE_PAD, bottomBound - cardHeight)),
      width: cardWidth,
      height: cardHeight,
    };
    const bottomCard = {
      left: MOBILE_PAD,
      top: Math.max(MOBILE_PAD, bottomBound - cardHeight),
      width: cardWidth,
      height: cardHeight,
    };
    const overlapArea = (card, rect) => {
      if (!rect) return 0;
      const horizontal = Math.max(0, Math.min(card.left + card.width, rect.left + rect.width + CARD_TARGET_GAP)
        - Math.max(card.left, rect.left - CARD_TARGET_GAP));
      const vertical = Math.max(0, Math.min(card.top + card.height, rect.top + rect.height + CARD_TARGET_GAP)
        - Math.max(card.top, rect.top - CARD_TARGET_GAP));
      return horizontal * vertical;
    };
    if (hole) {
      const capacities = {
        top: Math.max(0, hole.top - CARD_TARGET_GAP - topBound),
        bottom: Math.max(0, bottomBound - hole.top - hole.height - CARD_TARGET_GAP),
      };
      const minimumHeight = Math.min(cardHeight, CARD_MIN_USABLE_HEIGHT);
      const preferredSide = placement === 'top' ? 'top' : placement === 'bottom' ? 'bottom' : '';
      const fullSides = ['bottom', 'top'].filter(side => capacities[side] >= cardHeight);
      const readableSides = ['bottom', 'top'].filter(side => capacities[side] >= minimumHeight);
      let side = '';
      if (preferredSide && fullSides.includes(preferredSide)) side = preferredSide;
      else if (fullSides.length) side = fullSides[0];
      else if (readableSides.length) {
        side = readableSides.sort((a, b) => capacities[b] - capacities[a])[0];
      }
      if (side) {
        const constrainedMaxHeight = Math.max(1, Math.min(maxCardHeight, capacities[side]));
        const constrainedHeight = Math.min(cardHeight, constrainedMaxHeight);
        return {
          mobile,
          hole,
          placement: `${side}-fixed`,
          card: {
            left: MOBILE_PAD,
            top: side === 'top'
              ? hole.top - CARD_TARGET_GAP - constrainedHeight
              : hole.top + hole.height + CARD_TARGET_GAP,
            width: cardWidth,
            height: constrainedHeight,
            maxHeight: constrainedMaxHeight,
          },
        };
      }
    }
    const bottomOverlap = overlapArea(bottomCard, hole);
    const topOverlap = overlapArea(topCard, hole);
    const useTop = Boolean(hole) && bottomOverlap > 0 && topOverlap < bottomOverlap;
    return {
      mobile,
      hole,
      placement: useTop ? 'top-fixed' : 'bottom-fixed',
      card: { ...(useTop ? topCard : bottomCard), maxHeight: maxCardHeight },
    };
  }

  if (!hole) {
    return {
      mobile,
      hole,
      placement: 'center',
      card: {
        left: clamp((w - cardWidth) / 2, VIEWPORT_PAD, w - cardWidth - VIEWPORT_PAD),
        top: clamp(h * 0.34, VIEWPORT_PAD, h - cardHeight - VIEWPORT_PAD),
        width: cardWidth,
        height: cardHeight,
        maxHeight: maxCardHeight,
      },
    };
  }

  const requested = ['top', 'bottom', 'left', 'right'].includes(placement) ? placement : '';
  const available = {
    top: hole.top - VIEWPORT_PAD,
    bottom: h - VIEWPORT_PAD - hole.top - hole.height,
    left: hole.left - VIEWPORT_PAD,
    right: w - VIEWPORT_PAD - hole.left - hole.width,
  };
  const preferred = requested || Object.entries(available).sort((a, b) => b[1] - a[1])[0]?.[0] || 'bottom';
  const opposite = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };
  const order = [preferred, opposite[preferred], 'bottom', 'top', 'right', 'left']
    .filter((side, index, sides) => side && sides.indexOf(side) === index);
  const makeCandidate = (side, fullyClamp = false) => {
    let left = hole.left + hole.width / 2 - cardWidth / 2;
    let top = hole.top + hole.height / 2 - cardHeight / 2;
    if (side === 'bottom') top = hole.top + hole.height + CARD_TARGET_GAP;
    if (side === 'top') top = hole.top - cardHeight - CARD_TARGET_GAP;
    if (side === 'right') left = hole.left + hole.width + CARD_TARGET_GAP;
    if (side === 'left') left = hole.left - cardWidth - CARD_TARGET_GAP;
    if (side === 'top' || side === 'bottom' || fullyClamp) {
      left = clamp(left, VIEWPORT_PAD, w - cardWidth - VIEWPORT_PAD);
    }
    if (side === 'left' || side === 'right' || fullyClamp) {
      top = clamp(top, VIEWPORT_PAD, h - cardHeight - VIEWPORT_PAD);
    }
    const sideCapacity = side === 'top' || side === 'bottom'
      ? Math.max(1, available[side] - CARD_TARGET_GAP)
      : maxCardHeight;
    return {
      left,
      top,
      width: cardWidth,
      height: cardHeight,
      maxHeight: fullyClamp ? maxCardHeight : Math.min(maxCardHeight, sideCapacity),
    };
  };
  const fitsViewport = card => (
    card.left >= VIEWPORT_PAD && card.top >= VIEWPORT_PAD
    && card.left + card.width <= w - VIEWPORT_PAD
    && card.top + card.height <= h - VIEWPORT_PAD
  );
  let resolvedPlacement = order[0];
  let card = null;
  for (const side of order) {
    const candidate = makeCandidate(side);
    if (!fitsViewport(candidate)) continue;
    resolvedPlacement = side;
    card = candidate;
    break;
  }
  if (!card) {
    const minimumHeight = Math.min(cardHeight, CARD_MIN_USABLE_HEIGHT);
    for (const side of order.filter(value => value === 'top' || value === 'bottom')) {
      const capacity = Math.max(0, available[side] - CARD_TARGET_GAP);
      if (capacity < minimumHeight) continue;
      const constrainedHeight = Math.min(cardHeight, capacity);
      resolvedPlacement = side;
      card = {
        left: clamp(hole.left + hole.width / 2 - cardWidth / 2, VIEWPORT_PAD, w - cardWidth - VIEWPORT_PAD),
        top: side === 'top'
          ? hole.top - CARD_TARGET_GAP - constrainedHeight
          : hole.top + hole.height + CARD_TARGET_GAP,
        width: cardWidth,
        height: constrainedHeight,
        maxHeight: Math.min(maxCardHeight, capacity),
      };
      break;
    }
  }
  if (!card) {
    const overlapArea = (candidate) => {
      const horizontal = Math.max(0, Math.min(candidate.left + candidate.width, hole.left + hole.width)
        - Math.max(candidate.left, hole.left));
      const vertical = Math.max(0, Math.min(candidate.top + candidate.height, hole.top + hole.height)
        - Math.max(candidate.top, hole.top));
      return horizontal * vertical;
    };
    const fallback = order
      .map(side => ({ side, card: makeCandidate(side, true) }))
      .sort((a, b) => overlapArea(a.card) - overlapArea(b.card))[0];
    resolvedPlacement = fallback?.side || resolvedPlacement;
    card = fallback?.card || makeCandidate(resolvedPlacement, true);
  }
  return {
    mobile,
    hole,
    placement: resolvedPlacement,
    card,
  };
};

const injectStyle = (documentRef) => {
  if (!documentRef?.head || documentRef.getElementById?.(STYLE_ID)) return;
  const style = documentRef.createElement?.('style');
  if (!style) return;
  style.id = STYLE_ID;
  style.textContent = `
.maid-spotlight-root {
  position: fixed;
  inset: 0;
  z-index: 40000;
  display: none;
  color: var(--app-text-primary, #111827);
  pointer-events: none;
  user-select: none;
  isolation: isolate;
}
.maid-spotlight-root.is-active { display: block; }
.maid-spotlight-dim {
  position: absolute;
  background: color-mix(in srgb, var(--app-overlay-backdrop, #0f172a) 48%, transparent);
  pointer-events: auto;
  transition: opacity 180ms ease;
}
.maid-spotlight-dim-top,
.maid-spotlight-dim-bottom,
.maid-spotlight-dim-left,
.maid-spotlight-dim-right { contain: strict; }
.maid-spotlight-hole {
  position: absolute;
  border: 2px solid color-mix(in srgb, var(--app-accent-primary, #2563eb) 72%, white);
  border-radius: 16px;
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--app-surface-card, #fff) 62%, transparent), 0 0 28px 6px color-mix(in srgb, var(--app-accent-primary, #2563eb) 42%, transparent);
  opacity: 0;
  pointer-events: none;
  transition: opacity 180ms ease;
}
.maid-spotlight-root.has-target .maid-spotlight-hole { opacity: 1; }
.maid-spotlight-hole::after {
  content: '';
  position: absolute;
  inset: -2px;
  border: 2px solid var(--app-accent-primary, #2563eb);
  border-radius: inherit;
  animation: maid-spotlight-ring-pulse 1.9s cubic-bezier(.3,.2,.4,1) infinite;
}
.maid-spotlight-hand {
  position: absolute;
  display: none;
  align-items: center;
  gap: 5px;
  min-height: 26px;
  box-sizing: border-box;
  padding: 4px 10px;
  border: 1px solid color-mix(in srgb, var(--app-accent-primary, #2563eb) 18%, transparent);
  border-radius: 999px;
  background: var(--app-surface-card, #fff);
  color: var(--app-accent-primary, #2563eb);
  box-shadow: 0 10px 24px -12px color-mix(in srgb, var(--app-accent-primary, #2563eb) 56%, transparent);
  font-size: 11px;
  font-weight: 800;
  pointer-events: none;
  animation: maid-spotlight-hand-float 1.5s ease-in-out infinite;
}
.maid-spotlight-root.has-target.has-action .maid-spotlight-hand { display: inline-flex; }
.maid-spotlight-arrow {
  position: absolute;
  z-index: 2;
  width: 14px;
  height: 14px;
  display: none;
  border: 1px solid var(--app-border-subtle, rgba(148,163,184,.22));
  border-radius: 3px;
  background: var(--app-surface-card, #fff);
  pointer-events: none;
  transform: rotate(45deg);
  transition: opacity 180ms ease;
}
.maid-spotlight-root.has-card-arrow .maid-spotlight-arrow { display: block; }
.maid-spotlight-escape-hint {
  position: absolute;
  top: max(16px, env(safe-area-inset-top, 0px));
  right: 18px;
  z-index: 4;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 30px;
  box-sizing: border-box;
  padding: 4px 10px;
  border: 1px solid color-mix(in srgb, var(--app-surface-card, #fff) 18%, transparent);
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-surface-card, #fff) 15%, transparent);
  color: color-mix(in srgb, var(--app-text-inverse, #fff) 82%, transparent);
  font-size: 10.5px;
  font-weight: 700;
  pointer-events: none;
}
.maid-spotlight-escape-hint kbd {
  min-width: 26px;
  padding: 2px 5px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--app-surface-card, #fff) 20%, transparent);
  color: var(--app-text-inverse, #fff);
  font: 750 10px/1.2 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  text-align: center;
}
.maid-spotlight-icon-btn,
.maid-spotlight-primary,
.maid-spotlight-skip {
  border: 0;
  cursor: pointer;
  font: inherit;
  touch-action: manipulation;
}
.maid-spotlight-card {
  position: absolute;
  z-index: 3;
  width: min(384px, calc(100vw - 32px));
  max-height: calc(var(--app-visual-height, 100dvh) - 32px);
  box-sizing: border-box;
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, var(--app-text-muted, #64748b) 34%, transparent) transparent;
  border: 1px solid var(--app-border-subtle, rgba(148,163,184,.22));
  border-radius: 24px;
  background: color-mix(in srgb, var(--app-surface-card, #fff) 98%, var(--app-accent-primary, #2563eb));
  box-shadow: 0 28px 74px -24px rgba(15,23,42,.48);
  pointer-events: auto;
  transform-origin: center;
}
.maid-spotlight-card::-webkit-scrollbar { width: 5px; }
.maid-spotlight-card::-webkit-scrollbar-thumb {
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-text-muted, #64748b) 34%, transparent);
}
.maid-spotlight-root.is-rendering.is-opening .maid-spotlight-card {
  animation: maid-spotlight-card-in 360ms cubic-bezier(.22,1,.36,1) both;
  will-change: transform, opacity;
}
.maid-spotlight-root.is-rendering.is-stepping .maid-spotlight-card {
  animation: maid-spotlight-card-step-in 260ms cubic-bezier(.22,1,.36,1) backwards;
  will-change: transform;
}
.maid-spotlight-root.is-rendering .maid-spotlight-done-icon {
  animation: maid-spotlight-done-icon-in 420ms 90ms cubic-bezier(.22,1,.36,1) backwards;
}
.maid-spotlight-card-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 16px 8px;
}
.maid-spotlight-card-avatar-wrap {
  position: relative;
  width: 50px;
  height: 50px;
  flex: 0 0 50px;
}
.maid-spotlight-card-avatar {
  width: 50px;
  height: 50px;
  display: block;
  overflow: hidden;
  border: 2px solid color-mix(in srgb, var(--app-accent-secondary, #db2777) 18%, transparent);
  border-radius: 50%;
  background-color: var(--app-surface-subtle, #f8fafc);
}
.maid-spotlight-card-avatar-status {
  position: absolute;
  right: -1px;
  bottom: -1px;
  width: 11px;
  height: 11px;
  box-sizing: border-box;
  border: 2px solid var(--app-surface-card, #fff);
  border-radius: 50%;
  background: var(--app-success-text, #047857);
}
.maid-spotlight-card-copy { flex: 1; min-width: 0; }
.maid-spotlight-card-title { font-size: 12.5px; font-weight: 850; line-height: 1.25; }
.maid-spotlight-card-meta { margin-top: 2px; color: var(--app-text-muted, #64748b); font-size: 10.5px; }
.maid-spotlight-progress { display: flex; align-items: center; gap: 4px; }
.maid-spotlight-progress-dot {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: var(--app-border-default, rgba(148,163,184,.32));
  transition: width 300ms cubic-bezier(.22,1,.36,1), background 220ms ease;
}
.maid-spotlight-progress-dot.is-past { background: color-mix(in srgb, var(--app-accent-primary, #2563eb) 34%, transparent); }
.maid-spotlight-progress-dot.is-current {
  width: 17px;
  background: linear-gradient(90deg, var(--app-accent-primary, #2563eb), var(--app-accent-secondary, #7c3aed));
}
.maid-spotlight-text {
  min-height: 62px;
  box-sizing: border-box;
  padding: 8px 16px 10px;
  color: var(--app-text-secondary, #475569);
  font-size: 13px;
  line-height: 1.7;
  cursor: default;
}
.maid-spotlight-card:not(.is-typed) .maid-spotlight-text::after {
  content: '';
  display: inline-block;
  width: 2px;
  height: 14px;
  margin-left: 2px;
  vertical-align: -2px;
  background: var(--app-accent-primary, #2563eb);
  animation: maid-spotlight-caret 760ms steps(1,end) infinite;
}
.maid-spotlight-hint {
  display: none;
  align-items: center;
  gap: 6px;
  width: fit-content;
  max-width: calc(100% - 32px);
  box-sizing: border-box;
  margin: 0 16px 8px;
  padding: 5px 9px;
  border: 1px solid color-mix(in srgb, var(--app-accent-secondary, #7c3aed) 16%, transparent);
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-accent-secondary, #7c3aed) 7%, transparent);
  color: var(--app-accent-secondary, #7c3aed);
  font-size: 11px;
  font-weight: 750;
}
.maid-spotlight-hint.has-text {
  display: inline-flex;
  visibility: hidden;
  opacity: 0;
}
.maid-spotlight-hint svg { width: 13px; height: 13px; flex: 0 0 13px; }
.maid-spotlight-card.is-typed .maid-spotlight-hint.has-text {
  visibility: visible;
  opacity: 1;
  animation: maid-spotlight-hint-in 220ms cubic-bezier(.22,1,.36,1) backwards;
}
.maid-spotlight-actions {
  position: sticky;
  bottom: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px;
  padding: 4px 16px 15px;
  background: linear-gradient(180deg, transparent, var(--app-surface-card, #fff) 28%);
}
.maid-spotlight-skip {
  min-height: 40px;
  padding: 7px 0;
  background: transparent;
  color: var(--app-text-muted, #64748b);
  font-size: 11.5px;
  font-weight: 700;
  transition: color 180ms ease;
}
.maid-spotlight-action-group { display: flex; align-items: center; gap: 7px; margin-left: auto; }
.maid-spotlight-icon-btn {
  width: 40px;
  height: 40px;
  display: inline-grid;
  place-items: center;
  border: 1px solid var(--app-border-subtle, rgba(148,163,184,.22));
  border-radius: 50%;
  background: var(--app-surface-subtle, #f8fafc);
  color: var(--app-text-secondary, #475569);
  transition: color 180ms ease, background 180ms ease, transform 180ms cubic-bezier(.22,1,.36,1);
}
.maid-spotlight-primary {
  min-height: 40px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  box-sizing: border-box;
  padding: 0 16px;
  border-radius: 999px;
  background: linear-gradient(135deg, var(--app-accent-primary, #2563eb), var(--app-accent-secondary, #7c3aed));
  color: var(--app-text-inverse, #fff);
  box-shadow: 0 12px 22px -14px color-mix(in srgb, var(--app-accent-primary, #2563eb) 75%, transparent);
  font-size: 12px;
  font-weight: 850;
  white-space: nowrap;
  transition: opacity 180ms ease, transform 180ms cubic-bezier(.22,1,.36,1), box-shadow 180ms ease;
}
.maid-spotlight-primary:disabled { opacity: .48; cursor: default; }
.maid-spotlight-card.is-done { text-align: center; }
.maid-spotlight-card.is-done .maid-spotlight-card-head { justify-content: center; padding-top: 22px; }
.maid-spotlight-done-visual {
  position: relative;
  width: 76px;
  height: 72px;
}
.maid-spotlight-done-avatar {
  width: 72px;
  height: 72px;
  display: block;
  overflow: hidden;
  border: 2px solid color-mix(in srgb, var(--app-warning-text, #b45309) 24%, transparent);
  border-radius: 20px;
  background-color: var(--app-surface-subtle, #f8fafc);
  box-shadow: 0 14px 30px -20px color-mix(in srgb, var(--app-warning-text, #b45309) 70%, transparent);
}
.maid-spotlight-done-icon {
  position: absolute;
  right: -2px;
  bottom: -3px;
  width: 27px;
  height: 27px;
  display: grid;
  place-items: center;
  border: 2px solid var(--app-surface-card, #fff);
  border-radius: 10px;
  background: linear-gradient(135deg, var(--app-warning-text, #b45309), var(--app-accent-secondary, #db2777));
  color: var(--app-text-inverse, #fff);
  box-shadow: 0 10px 20px -12px color-mix(in srgb, var(--app-warning-text, #b45309) 70%, transparent);
}
.maid-spotlight-done-icon svg { width: 14px; height: 14px; }
.maid-spotlight-done-title { margin-top: 12px; font-size: 15px; font-weight: 900; }
.maid-spotlight-done-copy { margin: 7px 20px 0; color: var(--app-text-secondary, #475569); font-size: 12px; line-height: 1.6; }
.maid-spotlight-reward {
  display: inline-flex;
  margin-left: 4px;
  padding: 2px 8px;
  border: 1px solid color-mix(in srgb, var(--app-warning-text, #b45309) 14%, transparent);
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-warning-text, #b45309) 8%, transparent);
  color: var(--app-warning-text, #b45309);
  font-weight: 850;
}
.maid-spotlight-card.is-done .maid-spotlight-actions { justify-content: center; padding-top: 15px; }
.maid-spotlight-confetti { position: absolute; inset: 0; overflow: hidden; pointer-events: none; }
.maid-spotlight-confetti-piece {
  position: absolute;
  left: 50%;
  top: 18px;
  width: 7px;
  height: 4px;
  border-radius: 2px;
  background: var(--piece-color, var(--app-accent-primary, #2563eb));
  animation: maid-spotlight-confetti 980ms cubic-bezier(.15,.6,.4,1) both;
  animation-delay: var(--piece-delay, 0ms);
}
.maid-spotlight-root.is-mobile .maid-spotlight-card {
  max-height: calc(var(--app-visual-height, 100dvh) - 74px - env(safe-area-inset-bottom, 0px));
  border-radius: 22px;
}
.maid-spotlight-root.is-mobile .maid-spotlight-hand { display: none; }
.maid-spotlight-root.is-mobile .maid-spotlight-escape-hint { display: none; }
@media (hover:hover) and (pointer:fine) {
  .maid-spotlight-icon-btn:hover { background: var(--app-surface-subtle, #f8fafc); color: var(--app-text-primary, #111827); }
  .maid-spotlight-primary:not(:disabled):hover { transform: translateY(-1px) scale(1.025); box-shadow: 0 16px 28px -14px color-mix(in srgb, var(--app-accent-primary, #2563eb) 82%, transparent); }
  .maid-spotlight-skip:hover { color: var(--app-danger-text, #b91c1c); }
}
.maid-spotlight-primary:not(:disabled):active,
.maid-spotlight-icon-btn:active { transform: scale(.96); }
@keyframes maid-spotlight-ring-pulse { 0% { opacity:.85; transform:scale(1); } 72%,100% { opacity:0; transform:scale(1.14); } }
@keyframes maid-spotlight-hand-float { 0%,100% { transform:translateY(0); } 50% { transform:translateY(-4px); } }
@keyframes maid-spotlight-card-in { from { opacity:0; transform:translate3d(0,16px,0) scale(.96); } to { opacity:1; transform:translate3d(0,0,0) scale(1); } }
@keyframes maid-spotlight-card-step-in { from { transform:translate3d(0,8px,0) scale(.985); } to { transform:translate3d(0,0,0) scale(1); } }
@keyframes maid-spotlight-hint-in { from { opacity:0; transform:translate3d(0,5px,0); } to { opacity:1; transform:translate3d(0,0,0); } }
@keyframes maid-spotlight-done-icon-in { from { opacity:0; transform:scale(.55) rotate(-20deg); } to { opacity:1; transform:scale(1) rotate(0); } }
@keyframes maid-spotlight-caret { 0%,48% { opacity:1; } 49%,100% { opacity:0; } }
@keyframes maid-spotlight-confetti { to { opacity:0; transform:translate3d(var(--piece-x),var(--piece-y),0) rotate(var(--piece-r)); } }
@media (prefers-reduced-motion: reduce) {
  .maid-spotlight-root,
  .maid-spotlight-root *,
  .maid-spotlight-root *::before,
  .maid-spotlight-root *::after { animation:none !important; transition:none !important; scroll-behavior:auto !important; }
}
body[data-reduced-motion='on'] .maid-spotlight-root,
body[data-reduced-motion='on'] .maid-spotlight-root *,
body[data-reduced-motion='on'] .maid-spotlight-root *::before,
body[data-reduced-motion='on'] .maid-spotlight-root *::after { animation:none !important; transition:none !important; scroll-behavior:auto !important; }
`;
  documentRef.head.appendChild(style);
};

const createElement = (documentRef, tag, className = '', text = '') => {
  const element = documentRef.createElement?.(tag);
  if (!element) return null;
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
};

const iconSvg = body => `<svg viewBox="0 0 24 24" aria-hidden="true" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const ICONS = Object.freeze({
  back: iconSvg('<path d="m15 18-6-6 6-6"/>'),
  hand: iconSvg('<path d="M7 11V5a2 2 0 0 1 4 0v5-7a2 2 0 0 1 4 0v7-5a2 2 0 0 1 4 0v8c0 5-3 8-8 8h-1c-3 0-5-2-6-4l-2-4a2 2 0 0 1 3-2l2 2"/>'),
  wand: iconSvg('<path d="m15 4 5 5L8 21l-5-5Z"/><path d="m6 14 5 5"/><path d="M14 2v3"/><path d="M22 10h-3"/>'),
  trophy: iconSvg('<path d="M8 21h8"/><path d="M12 17v4"/><path d="M7 4h10v5a5 5 0 0 1-10 0Z"/><path d="M7 6H4v2a3 3 0 0 0 3 3"/><path d="M17 6h3v2a3 3 0 0 1-3 3"/>'),
});

export const createMaidGuideSpotlight = ({
  documentRef = globalThis?.document || null,
  windowRef = globalThis?.window || null,
  resolveTarget = null,
  getViewportSize = null,
  setTimeoutFn = globalThis?.setTimeout || null,
  clearTimeoutFn = globalThis?.clearTimeout || null,
  setIntervalFn = globalThis?.setInterval || null,
  clearIntervalFn = globalThis?.clearInterval || null,
  requestAnimationFrameFn = globalThis?.requestAnimationFrame || null,
  cancelAnimationFrameFn = globalThis?.cancelAnimationFrame || null,
  matchMediaFn = globalThis?.matchMedia || null,
  MutationObserverFn = windowRef?.MutationObserver || globalThis?.MutationObserver || null,
} = {}) => {
  let root = null;
  let dims = [];
  let holeEl = null;
  let arrowEl = null;
  let handEl = null;
  let escapeHintEl = null;
  let cardEl = null;
  let active = false;
  let current = null;
  let currentTarget = null;
  let targetObserver = null;
  let domObserver = null;
  let typeTimer = null;
  let renderTimer = null;
  let frameId = null;
  let scrollRequestedTarget = null;
  let shownCharacters = 0;
  let typedDone = false;
  let targetRetryTimer = null;
  let targetResolveDeadline = 0;
  let renderedHole = null;
  let renderedArrow = null;
  let lastGeometryFrameAt = 0;
  let geometryStableFrames = 0;
  let lastTrackedTargetRect = null;
  let lastLayout = null;

  const clearTypeTimer = () => {
    if (typeTimer == null) return;
    clearIntervalFn?.(typeTimer);
    typeTimer = null;
  };

  const clearRenderTimer = () => {
    if (renderTimer == null) return;
    clearTimeoutFn?.(renderTimer);
    renderTimer = null;
  };

  const clearTargetRetryTimer = () => {
    if (targetRetryTimer == null) return;
    clearTimeoutFn?.(targetRetryTimer);
    targetRetryTimer = null;
  };

  const scheduleTargetRetry = () => {
    if (targetRetryTimer != null || typeof setTimeoutFn !== 'function') return;
    targetRetryTimer = setTimeoutFn(() => {
      targetRetryTimer = null;
      scheduleRefresh();
    }, TARGET_RESOLVE_RETRY_MS);
  };

  const disconnectTargetObserver = () => {
    try { targetObserver?.disconnect?.(); } catch {}
    targetObserver = null;
  };

  const getViewport = () => {
    const custom = typeof getViewportSize === 'function' ? getViewportSize() : null;
    const visualHeight = Number.parseFloat(documentRef?.documentElement?.style?.getPropertyValue?.('--app-visual-height') || '');
    return {
      w: Number(custom?.w || custom?.width || windowRef?.innerWidth || 0) || 0,
      h: Number(custom?.h || custom?.height || visualHeight || windowRef?.innerHeight || 0) || 0,
    };
  };

  const ensure = () => {
    if (root || !documentRef?.body) return root;
    injectStyle(documentRef);
    root = createElement(documentRef, 'div', 'maid-spotlight-root');
    root.setAttribute?.('aria-hidden', 'true');
    ['top', 'bottom', 'left', 'right'].forEach((side) => {
      const dim = createElement(documentRef, 'div', `maid-spotlight-dim maid-spotlight-dim-${side}`);
      dims.push(dim);
      root.appendChild(dim);
    });
    holeEl = createElement(documentRef, 'div', 'maid-spotlight-hole');
    arrowEl = createElement(documentRef, 'div', 'maid-spotlight-arrow');
    handEl = createElement(documentRef, 'div', 'maid-spotlight-hand');
    handEl.innerHTML = `${ICONS.hand}<span></span>`;
    escapeHintEl = createElement(documentRef, 'div', 'maid-spotlight-escape-hint');
    escapeHintEl.setAttribute?.('aria-hidden', 'true');
    escapeHintEl.innerHTML = '<span>按</span><kbd>Esc</kbd><span>可随时让女仆收工</span>';
    root.append(...dims, holeEl, arrowEl, handEl, escapeHintEl);
    documentRef.body.appendChild(root);
    resetGeometry();
    return root;
  };

  const resolveLiveTarget = () => {
    if (typeof current?.resolveStepTarget === 'function') {
      try {
        const target = current.resolveStepTarget() || null;
        if (!target?.getBoundingClientRect) return null;
        const rect = target.getBoundingClientRect();
        return Number(rect.width) > 0 && Number(rect.height) > 0 ? target : null;
      } catch {
        return null;
      }
    }
    const targetKey = current?.step?.target || '';
    if (!targetKey || typeof resolveTarget !== 'function') return null;
    try {
      const target = resolveTarget(targetKey, current?.flow, current?.step) || null;
      if (!target?.getBoundingClientRect) return null;
      const rect = target.getBoundingClientRect();
      if (!(Number(rect.width) > 0 && Number(rect.height) > 0)) return null;
      return target;
    } catch {
      return null;
    }
  };

  const observeTarget = target => {
    if (target === currentTarget && targetObserver) return;
    disconnectTargetObserver();
    currentTarget = target;
    if (!target || typeof windowRef?.ResizeObserver !== 'function') return;
    try {
      const initialRect = target.getBoundingClientRect?.() || null;
      let initialResizeDelivery = true;
      targetObserver = new windowRef.ResizeObserver(() => {
        if (initialResizeDelivery) {
          initialResizeDelivery = false;
          const nextRect = target.getBoundingClientRect?.() || null;
          const targetGeometryChanged = hasRectChanged(initialRect, nextRect);
          if (!targetGeometryChanged) return;
        }
        scheduleRefresh();
      });
      targetObserver.observe(target);
    } catch {
      disconnectTargetObserver();
    }
  };

  const applyStyleValue = (element, property, value) => {
    if (!element?.style) return;
    if (element.style[property] !== value) element.style[property] = value;
  };

  const geometryPx = value => `${Math.round((Number(value) || 0) * 1_000_000) / 1_000_000}px`;

  const applyBox = (element, box = {}) => {
    applyStyleValue(element, 'left', geometryPx(box.left));
    applyStyleValue(element, 'top', geometryPx(box.top));
    applyStyleValue(element, 'width', geometryPx(Math.max(0, Number(box.width) || 0)));
    applyStyleValue(element, 'height', geometryPx(Math.max(0, Number(box.height) || 0)));
  };

  const applyCardBox = (element, box = {}) => {
    applyStyleValue(element, 'left', `${Math.round(Number(box.left) || 0)}px`);
    applyStyleValue(element, 'top', `${Math.round(Number(box.top) || 0)}px`);
    applyStyleValue(element, 'width', `${Math.max(1, Math.round(Number(box.width) || CARD_WIDTH))}px`);
    applyStyleValue(element, 'height', 'auto');
    applyStyleValue(element, 'maxHeight', `${Math.max(1, Math.round(Number(box.maxHeight) || 1))}px`);
  };

  const resetGeometry = () => {
    if (!root) return;
    const viewport = getViewport();
    const full = { left: 0, top: 0, width: viewport.w, height: viewport.h };
    renderedHole = { left: 0, top: 0, width: 0, height: 0 };
    renderedArrow = { left: 0, top: 0, width: 14, height: 14 };
    lastGeometryFrameAt = 0;
    geometryStableFrames = 0;
    lastTrackedTargetRect = null;
    applyBox(dims[0], full);
    dims.slice(1).forEach(dim => applyBox(dim, { left: 0, top: 0, width: 0, height: 0 }));
    applyBox(holeEl, renderedHole);
    applyBox(arrowEl, renderedArrow);
  };

  const resolveArrowGeometry = (layout, hole) => {
    const placement = String(layout?.placement || '');
    const card = layout?.card || {};
    const showArrow = Boolean(hole && !layout?.mobile && ['top', 'bottom', 'left', 'right'].includes(placement));
    if (!showArrow) return { show: false, placement: '', box: renderedArrow };
    const size = 14;
    const targetCenterX = hole.left + hole.width / 2;
    const targetCenterY = hole.top + hole.height / 2;
    let left = card.left + card.width / 2 - size / 2;
    let top = card.top + card.height / 2 - size / 2;
    if (placement === 'bottom' || placement === 'top') {
      left = clamp(targetCenterX - size / 2, card.left + 24, card.left + card.width - size - 24);
      top = placement === 'bottom' ? card.top - size / 2 : card.top + card.height - size / 2;
    } else {
      left = placement === 'right' ? card.left - size / 2 : card.left + card.width - size / 2;
      top = clamp(targetCenterY - size / 2, card.top + 24, card.top + card.height - size - 24);
    }
    return {
      show: true,
      placement,
      box: { left, top, width: size, height: size },
    };
  };

  const refresh = (frameTime = null) => {
    frameId = null;
    if (!active || !root || !current) return;
    const viewport = getViewport();
    const target = current.phase === 'done' ? null : resolveLiveTarget();
    // 目标在场时滑动续期宽限：步内目标短暂消失（如浮层关闭、面板切换）走保持几何分支，而不是追向全屏 dim
    if (target) targetResolveDeadline = Date.now() + TARGET_RESOLVE_GRACE_MS;
    const expectsTarget = current.phase !== 'done' && current.expectsTarget === true;
    const waitingForTarget = expectsTarget && !target && Date.now() < targetResolveDeadline;
    if (waitingForTarget && lastLayout?.card) {
      applyCardBox(cardEl, lastLayout.card);
      scheduleTargetRetry();
      return;
    }
    if (waitingForTarget) scheduleTargetRetry();
    else clearTargetRetryTimer();
    const targetRect = target?.getBoundingClientRect?.() || null;
    observeTarget(target);
    if (
      target &&
      target !== scrollRequestedTarget &&
      isMaidGuideTargetOutsideViewport({ rect: targetRect, viewport })
    ) {
      scrollRequestedTarget = target;
      try {
        target.scrollIntoView?.({
          block: 'center',
          inline: 'center',
          behavior: isMaidGuideMotionReduced(documentRef, matchMediaFn) ? 'auto' : 'smooth',
        });
      } catch {}
    }
    const measuredCard = cardEl?.getBoundingClientRect?.() || {};
    const layout = calculateMaidSpotlightLayout({
      viewport,
      targetRect,
      cardSize: {
        width: CARD_WIDTH,
        height: Number(cardEl?.scrollHeight || measuredCard.height || CARD_ESTIMATED_HEIGHT) || CARD_ESTIMATED_HEIGHT,
      },
      placement: current.step?.placement,
      safeBottom: Number.parseFloat(windowRef?.getComputedStyle?.(documentRef?.documentElement)?.getPropertyValue?.('--app-safe-bottom') || '') || 0,
    });
    const destinationHole = layout.hole || { left: 0, top: 0, width: 0, height: 0 };
    const reducedMotion = isMaidGuideMotionReduced(documentRef, matchMediaFn);
    const sampledFrameTime = Number(frameTime);
    const now = Number.isFinite(sampledFrameTime)
      ? sampledFrameTime
      : Number(windowRef?.performance?.now?.() || Date.now());
    const elapsed = lastGeometryFrameAt > 0 ? now - lastGeometryFrameAt : GEOMETRY_DEFAULT_FRAME_MS;
    const deltaMs = elapsed > 0 && elapsed < 120 ? elapsed : GEOMETRY_DEFAULT_FRAME_MS;
    lastGeometryFrameAt = now;
    const targetMoved = Boolean(
      targetRect
      && lastTrackedTargetRect
      && hasRectChanged(lastTrackedTargetRect, targetRect, 0.25),
    );
    lastTrackedTargetRect = targetRect
      ? {
        left: rectValue(targetRect, 'left'),
        top: rectValue(targetRect, 'top'),
        width: rectValue(targetRect, 'width'),
        height: rectValue(targetRect, 'height'),
      }
      : null;

    const holeStep = advanceMaidSpotlightBox({
      current: renderedHole,
      target: destinationHole,
      deltaMs,
      reducedMotion,
    });
    renderedHole = holeStep.box;
    const maskGeometry = resolveMaidSpotlightMaskGeometry({
      viewport,
      hole: renderedHole,
      devicePixelRatio: windowRef?.devicePixelRatio,
    });
    applyBox(dims[0], maskGeometry.panes.top);
    applyBox(dims[1], maskGeometry.panes.bottom);
    applyBox(dims[2], maskGeometry.panes.left);
    applyBox(dims[3], maskGeometry.panes.right);
    applyBox(holeEl, maskGeometry.hole);
    if (layout.hole) {
      if (handEl?.style) {
        applyStyleValue(handEl, 'left', geometryPx(clamp(maskGeometry.hole.left + maskGeometry.hole.width - 18, 8, viewport.w - 116)));
        applyStyleValue(handEl, 'top', geometryPx(clamp(maskGeometry.hole.top - 15, 8, viewport.h - 34)));
      }
    }
    root.classList?.toggle?.('has-target', Boolean(layout.hole));
    root.classList?.toggle?.('is-mobile', layout.mobile);
    applyCardBox(cardEl, layout.card);
    const arrowGeometry = resolveArrowGeometry(layout, layout.hole);
    root.classList?.toggle?.('has-card-arrow', arrowGeometry.show);
    let arrowSettled = true;
    if (arrowGeometry.show) {
      arrowEl.dataset.placement = arrowGeometry.placement;
      const arrowStep = advanceMaidSpotlightBox({
        current: renderedArrow,
        target: arrowGeometry.box,
        deltaMs,
        reducedMotion,
      });
      renderedArrow = arrowStep.box;
      arrowSettled = arrowStep.settled;
      applyBox(arrowEl, renderedArrow);
    }
    lastLayout = layout;
    const boxesSettled = holeStep.settled && arrowSettled;
    if (reducedMotion) {
      geometryStableFrames = GEOMETRY_STABLE_FRAME_COUNT;
    } else if (boxesSettled && !targetMoved) {
      geometryStableFrames += 1;
    } else {
      geometryStableFrames = 0;
    }
    const geometrySettled = reducedMotion
      || (boxesSettled && geometryStableFrames >= GEOMETRY_STABLE_FRAME_COUNT);
    if (!geometrySettled) scheduleRefresh();
  };

  const scheduleRefresh = () => {
    if (!active || frameId != null) return;
    if (typeof requestAnimationFrameFn === 'function') {
      frameId = requestAnimationFrameFn(refresh);
    } else {
      refresh();
    }
  };

  const finishTyping = () => {
    clearTypeTimer();
    typedDone = true;
    shownCharacters = String(current?.step?.text || '').length;
    const textEl = cardEl?.querySelector?.('.maid-spotlight-text');
    if (textEl) {
      textEl.textContent = String(current?.step?.text || '');
    }
    cardEl?.classList?.add?.('is-typed');
    const primary = cardEl?.querySelector?.('.maid-spotlight-primary');
    if (primary && current?.phase !== 'done') primary.disabled = current?.step?.action !== 'observe' && !current?.step?.fallback;
    scheduleRefresh();
  };

  const startTyping = () => {
    clearTypeTimer();
    const text = String(current?.step?.text || '');
    const textEl = cardEl?.querySelector?.('.maid-spotlight-text');
    shownCharacters = 0;
    typedDone = !text;
    cardEl?.classList?.toggle?.('is-typed', typedDone);
    if (!textEl) return;
    textEl.textContent = text;
    const reservedTextHeight = Math.ceil(Number(textEl.scrollHeight) || 0);
    if (reservedTextHeight > 0) textEl.style.minHeight = `${reservedTextHeight}px`;
    textEl.textContent = '';
    if (!text || isMaidGuideMotionReduced(documentRef, matchMediaFn) || typeof setIntervalFn !== 'function') {
      finishTyping();
      return;
    }
    typeTimer = setIntervalFn(() => {
      shownCharacters = Math.min(text.length, shownCharacters + 1);
      textEl.textContent = text.slice(0, shownCharacters);
      if (shownCharacters >= text.length) finishTyping();
    }, 18);
  };

  const appendProgress = (container, total, index) => {
    for (let i = 0; i < total; i += 1) {
      const dot = createElement(documentRef, 'span', 'maid-spotlight-progress-dot');
      if (i < index) dot.classList?.add?.('is-past');
      if (i === index) dot.classList?.add?.('is-current');
      container.appendChild(dot);
    }
  };

  const appendConfetti = (container) => {
    if (isMaidGuideMotionReduced(documentRef, matchMediaFn)) return;
    const colors = [
      'var(--app-accent-primary, #2563eb)',
      'var(--app-success-text, #047857)',
      'var(--app-warning-text, #b45309)',
      'var(--app-accent-secondary, #7c3aed)',
    ];
    for (let i = 0; i < 24; i += 1) {
      const piece = createElement(documentRef, 'span', 'maid-spotlight-confetti-piece');
      piece.style.setProperty('--piece-x', `${Math.round((Math.random() - 0.5) * 290)}px`);
      piece.style.setProperty('--piece-y', `${Math.round(90 + Math.random() * 150)}px`);
      piece.style.setProperty('--piece-r', `${Math.round((Math.random() - 0.5) * 620)}deg`);
      piece.style.setProperty('--piece-delay', `${Math.round(Math.random() * 120)}ms`);
      piece.style.setProperty('--piece-color', colors[i % colors.length]);
      container.appendChild(piece);
    }
  };

  const renderDoneCard = () => {
    cardEl.className = 'maid-spotlight-card is-done is-typed';
    const confetti = createElement(documentRef, 'div', 'maid-spotlight-confetti');
    appendConfetti(confetti);
    const head = createElement(documentRef, 'div', 'maid-spotlight-card-head');
    const visual = createElement(documentRef, 'div', 'maid-spotlight-done-visual');
    const avatar = createElement(documentRef, 'span', 'maid-spotlight-done-avatar');
    applyMaidGuideExpression(avatar, 'complete');
    avatar.setAttribute?.('aria-hidden', 'true');
    const icon = createElement(documentRef, 'div', 'maid-spotlight-done-icon');
    icon.innerHTML = ICONS.trophy;
    visual.append(avatar, icon);
    head.appendChild(visual);
    const title = createElement(documentRef, 'div', 'maid-spotlight-done-title', current.flow.doneText || `${current.flow.title} · 完成`);
    const copy = createElement(documentRef, 'div', 'maid-spotlight-done-copy');
    copy.append('主人真是一点就通～获得成就 ');
    copy.appendChild(createElement(documentRef, 'span', 'maid-spotlight-reward', `「${current.flow.reward || '新手上路'}」`));
    const actions = createElement(documentRef, 'div', 'maid-spotlight-actions');
    const finish = createElement(documentRef, 'button', 'maid-spotlight-primary', '收入囊中');
    finish.type = 'button';
    finish.addEventListener?.('click', () => current?.onFinish?.());
    actions.appendChild(finish);
    cardEl.append(confetti, head, title, copy, actions);
  };

  const renderStepCard = () => {
    const { flow, step, index } = current;
    cardEl.className = 'maid-spotlight-card';
    const head = createElement(documentRef, 'div', 'maid-spotlight-card-head');
    const avatarWrap = createElement(documentRef, 'div', 'maid-spotlight-card-avatar-wrap');
    const avatar = createElement(documentRef, 'span', 'maid-spotlight-card-avatar');
    applyMaidGuideExpression(avatar, resolveMaidGuideExpressionState({
      phase: current.phase,
      step,
      index,
    }));
    avatar.setAttribute?.('aria-hidden', 'true');
    const avatarStatus = createElement(documentRef, 'span', 'maid-spotlight-card-avatar-status');
    avatarStatus.setAttribute?.('aria-hidden', 'true');
    avatarWrap.append(avatar, avatarStatus);
    const copy = createElement(documentRef, 'div', 'maid-spotlight-card-copy');
    copy.append(
      createElement(documentRef, 'div', 'maid-spotlight-card-title', `女仆 · ${flow.title}`),
      createElement(documentRef, 'div', 'maid-spotlight-card-meta', `第 ${index + 1} 步，共 ${flow.steps.length} 步`),
    );
    const progress = createElement(documentRef, 'div', 'maid-spotlight-progress');
    appendProgress(progress, flow.steps.length, index);
    head.append(avatarWrap, copy, progress);

    const text = createElement(documentRef, 'div', 'maid-spotlight-text');
    text.setAttribute?.('title', '点击可立即显示完整文字');
    text.addEventListener?.('click', finishTyping);
    const hint = createElement(documentRef, 'div', `maid-spotlight-hint${step.hint ? ' has-text' : ''}`);
    if (step.hint) {
      const hintIcon = createElement(documentRef, 'span', 'maid-spotlight-hint-icon');
      hintIcon.innerHTML = ICONS.hand;
      hint.append(hintIcon, createElement(documentRef, 'span', 'maid-spotlight-hint-text', step.hint));
    }
    const actions = createElement(documentRef, 'div', 'maid-spotlight-actions');
    const skip = createElement(documentRef, 'button', 'maid-spotlight-skip', '跳过引导');
    skip.type = 'button';
    skip.dataset.maidGuideAction = 'skip';
    skip.addEventListener?.('click', () => current?.onSkip?.());
    const group = createElement(documentRef, 'div', 'maid-spotlight-action-group');
    if (index > 0 && typeof current?.onPrev === 'function') {
      const prev = createElement(documentRef, 'button', 'maid-spotlight-icon-btn');
      prev.type = 'button';
      prev.setAttribute?.('aria-label', '上一步');
      prev.innerHTML = ICONS.back;
      prev.addEventListener?.('click', () => current?.onPrev?.());
      group.appendChild(prev);
    }
    const primary = createElement(documentRef, 'button', 'maid-spotlight-primary');
    primary.type = 'button';
    const observe = step.action === 'observe';
    const hasFallback = Boolean(step.fallback);
    primary.disabled = true;
    primary.dataset.maidGuideAction = observe ? 'continue' : 'assist-click';
    primary.innerHTML = observe
      ? `<span>${step.primaryLabel || '下一步'}</span>`
      : hasFallback
        ? `${ICONS.wand}<span>${step.primaryLabel || '帮主人来'}</span>`
        : '<span>等待主人操作</span>';
    primary.addEventListener?.('click', () => {
      if (!typedDone) return;
      if (observe) current?.onNext?.();
      else if (hasFallback) current?.onFallback?.();
    });
    group.appendChild(primary);
    actions.append(skip, group);
    cardEl.append(head, text, hint, actions);
    startTyping();
  };

  const render = ({ animationKind = 'none' } = {}) => {
    if (!ensure() || !current) return false;
    clearTypeTimer();
    clearRenderTimer();
    clearTargetRetryTimer();
    targetResolveDeadline = Date.now() + TARGET_RESOLVE_GRACE_MS;
    lastGeometryFrameAt = 0;
    geometryStableFrames = 0;
    lastTrackedTargetRect = null;
    root?.classList?.remove?.('is-rendering', 'is-opening', 'is-stepping');
    cardEl?.remove?.();
    cardEl = createElement(documentRef, 'section', 'maid-spotlight-card');
    cardEl.setAttribute?.('role', 'dialog');
    cardEl.setAttribute?.('aria-modal', 'true');
    cardEl.setAttribute?.('aria-label', current.phase === 'done' ? '女仆引导完成' : '女仆引导步骤');
    root.appendChild(cardEl);
    root.classList?.toggle?.('has-action', current.phase !== 'done' && current.step?.action !== 'observe');
    root.classList?.toggle?.('is-done', current.phase === 'done');
    if (current.phase === 'done') renderDoneCard();
    else renderStepCard();
    const handText = handEl?.querySelector?.('span');
    if (handText) handText.textContent = current.step?.action === 'type' ? '在这里输入' : '点击这里';
    if (!isMaidGuideMotionReduced(documentRef, matchMediaFn) && animationKind !== 'none') {
      root.classList?.add?.('is-rendering', animationKind === 'opening' ? 'is-opening' : 'is-stepping');
      renderTimer = setTimeoutFn?.(() => {
        renderTimer = null;
        root?.classList?.remove?.('is-rendering', 'is-opening', 'is-stepping');
      }, 420);
    } else {
      root.classList?.remove?.('is-rendering', 'is-opening', 'is-stepping');
    }
    scheduleRefresh();
    return true;
  };

  const onViewportChange = () => scheduleRefresh();
  const onKeydown = event => {
    if (!active || event?.key !== 'Escape') return;
    event.preventDefault?.();
    event.stopPropagation?.();
    current?.onSkip?.();
  };

  const bind = () => {
    windowRef?.addEventListener?.('resize', onViewportChange);
    documentRef?.addEventListener?.('scroll', onViewportChange, true);
    documentRef?.addEventListener?.('keydown', onKeydown, true);
    if (typeof MutationObserverFn === 'function' && documentRef?.body) {
      try {
        domObserver = new MutationObserverFn((records = []) => {
          if (records.some(record => !root?.contains?.(record?.target))) scheduleRefresh();
        });
        domObserver.observe(documentRef.body, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['class', 'hidden', 'aria-hidden', 'style'],
        });
      } catch {
        domObserver = null;
      }
    }
  };

  const unbind = () => {
    windowRef?.removeEventListener?.('resize', onViewportChange);
    documentRef?.removeEventListener?.('scroll', onViewportChange, true);
    documentRef?.removeEventListener?.('keydown', onKeydown, true);
    try { domObserver?.disconnect?.(); } catch {}
    domObserver = null;
  };

  const hide = () => {
    if (!active && !root) return false;
    active = false;
    clearTypeTimer();
    clearRenderTimer();
    clearTargetRetryTimer();
    if (frameId != null) cancelAnimationFrameFn?.(frameId);
    frameId = null;
    disconnectTargetObserver();
    currentTarget = null;
    scrollRequestedTarget = null;
    targetResolveDeadline = 0;
    lastLayout = null;
    unbind();
    root?.classList?.remove?.('is-active', 'is-rendering', 'is-opening', 'is-stepping', 'has-target', 'has-action', 'has-card-arrow', 'is-done', 'is-mobile');
    resetGeometry();
    root?.setAttribute?.('aria-hidden', 'true');
    if (documentRef?.body?.dataset) delete documentRef.body.dataset.maidSpotlight;
    current = null;
    return true;
  };

  const show = ({
    flow = null,
    index = 0,
    phase = 'steps',
    onNext = null,
    onPrev = null,
    onSkip = null,
    onFallback = null,
    onFinish = null,
    resolveStepTarget = null,
    expectsTarget = null,
  } = {}) => {
    const steps = Array.isArray(flow?.steps) ? flow.steps : [];
    if (!flow || !steps.length) return false;
    const safeIndex = clamp(Math.trunc(Number(index) || 0), 0, steps.length - 1);
    const firstShow = !active;
    const normalizedPhase = phase === 'done' ? 'done' : 'steps';
    const sameView = active
      && current?.flow?.id === flow?.id
      && current?.index === safeIndex
      && current?.phase === normalizedPhase;
    active = true;
    scrollRequestedTarget = null;
    current = {
      flow,
      index: safeIndex,
      phase: normalizedPhase,
      step: steps[safeIndex],
      onNext,
      onPrev,
      onSkip,
      onFallback,
      onFinish,
      resolveStepTarget,
      expectsTarget: expectsTarget == null
        ? Boolean(String(steps[safeIndex]?.target || '').trim())
        : expectsTarget === true,
    };
    ensure();
    if (firstShow) bind();
    root.classList?.add?.('is-active');
    root.setAttribute?.('aria-hidden', 'false');
    if (documentRef?.body?.dataset) documentRef.body.dataset.maidSpotlight = 'on';
    return render({ animationKind: firstShow ? 'opening' : sameView ? 'none' : 'stepping' });
  };

  const destroy = () => {
    hide();
    root?.remove?.();
    root = null;
    dims = [];
    holeEl = null;
    arrowEl = null;
    handEl = null;
    escapeHintEl = null;
    cardEl = null;
  };

  return {
    destroy,
    hide,
    isActive: () => active,
    refresh: scheduleRefresh,
    show,
    getCurrentTarget: () => currentTarget,
    getElements: () => ({ root, dims, holeEl, arrowEl, handEl, escapeHintEl, cardEl }),
  };
};
