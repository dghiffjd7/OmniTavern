import { applyMaidGuideExpression } from './maid-guide-expression-utils.js';

export const PRESET_PREVIEW_DISCOVERY_HINT_ID = 'preset-preview-edge-discovery-v1';

const STYLE_ID = 'preset-preview-discovery-guide-style';
const VIEWPORT_GAP = 8;
const TARGET_GAP = 12;
const DEFAULT_MARKER_WIDTH = 164;
const DEFAULT_MARKER_HEIGHT = 64;

const clamp = (value, min, max) => Math.min(Math.max(Number(value) || 0, min), Math.max(min, max));

export const calculatePresetPreviewDiscoveryPosition = ({
  targetRect = null,
  markerSize = {},
  viewport = {},
} = {}) => {
  const targetLeft = Number(targetRect?.left) || 0;
  const targetTop = Number(targetRect?.top) || 0;
  const targetHeight = Math.max(0, Number(targetRect?.height) || 0);
  const markerWidth = Math.max(1, Number(markerSize?.width) || DEFAULT_MARKER_WIDTH);
  const markerHeight = Math.max(1, Number(markerSize?.height) || DEFAULT_MARKER_HEIGHT);
  const viewportWidth = Math.max(markerWidth + VIEWPORT_GAP * 2, Number(viewport?.width) || 0);
  const viewportHeight = Math.max(markerHeight + VIEWPORT_GAP * 2, Number(viewport?.height) || 0);
  return {
    left: Math.round(clamp(
      targetLeft - markerWidth - TARGET_GAP,
      VIEWPORT_GAP,
      viewportWidth - markerWidth - VIEWPORT_GAP,
    )),
    top: Math.round(clamp(
      targetTop + targetHeight / 2 - markerHeight / 2,
      VIEWPORT_GAP,
      viewportHeight - markerHeight - VIEWPORT_GAP,
    )),
  };
};

const ensureStyle = (documentRef) => {
  if (!documentRef?.head || documentRef.getElementById?.(STYLE_ID)) return;
  const style = documentRef.createElement?.('style');
  if (!style) return;
  style.id = STYLE_ID;
  style.textContent = `
.preset-preview-discovery-guide {
  position: fixed;
  z-index: 21400;
  display: none;
  align-items: center;
  gap: 7px;
  width: 164px;
  min-height: 64px;
  padding: 7px 9px 7px 7px;
  border: 1px solid color-mix(in srgb, var(--app-accent-primary, #8b5cf6) 34%, transparent);
  border-radius: 17px;
  background: color-mix(in srgb, var(--app-surface-card, #fff) 94%, transparent);
  box-shadow: 0 12px 30px rgba(15, 23, 42, .2), 0 2px 8px rgba(15, 23, 42, .12);
  color: var(--app-text-primary, #1f2937);
  pointer-events: none;
  isolation: isolate;
}
.preset-preview-discovery-guide-avatar {
  flex: 0 0 48px;
  width: 48px;
  height: 48px;
  border: 2px solid rgba(255, 255, 255, .9);
  border-radius: 50%;
  box-shadow: 0 3px 10px rgba(15, 23, 42, .18);
}
.preset-preview-discovery-guide-copy {
  min-width: 0;
  font-size: 12px;
  font-weight: 700;
  line-height: 1.3;
  text-align: center;
}
.preset-preview-discovery-guide-arrow {
  flex: 0 0 auto;
  color: var(--app-accent-primary, #8b5cf6);
  font-family: Georgia, "Times New Roman", serif;
  font-size: 28px;
  font-weight: 700;
  line-height: 1;
  filter: drop-shadow(0 2px 4px rgba(15, 23, 42, .18));
  animation: preset-preview-discovery-point 850ms ease-in-out infinite;
}
@keyframes preset-preview-discovery-point {
  0%, 100% { transform: translateX(0); }
  50% { transform: translateX(6px); }
}
body[data-reduced-motion='on'] .preset-preview-discovery-guide-arrow {
  animation: none;
}
@media (prefers-reduced-motion: reduce) {
  .preset-preview-discovery-guide-arrow { animation: none; }
}
@media (max-width: 420px) {
  .preset-preview-discovery-guide {
    width: 150px;
    min-height: 60px;
    gap: 5px;
  }
  .preset-preview-discovery-guide-avatar {
    flex-basis: 44px;
    width: 44px;
    height: 44px;
  }
  .preset-preview-discovery-guide-copy { font-size: 11px; }
  .preset-preview-discovery-guide-arrow { font-size: 25px; }
}
`;
  documentRef.head.appendChild(style);
};

export const createPresetPreviewDiscoveryGuide = ({
  documentRef = globalThis?.document || null,
  windowRef = globalThis?.window || null,
  guideStore = null,
} = {}) => {
  let element = null;
  let target = null;
  let frameId = 0;
  let listenersBound = false;
  let completed = false;

  const isDismissed = () => {
    if (completed) return true;
    try {
      return guideStore?.isHintDismissed?.(PRESET_PREVIEW_DISCOVERY_HINT_ID) === true;
    } catch {
      return false;
    }
  };

  const ensureElement = () => {
    if (element) return element;
    if (!documentRef?.body || typeof documentRef.createElement !== 'function') return null;
    ensureStyle(documentRef);
    element = documentRef.createElement('div');
    element.className = 'preset-preview-discovery-guide';
    element.classList?.add?.('preset-preview-discovery-guide');
    element.setAttribute?.('role', 'status');
    element.setAttribute?.('aria-live', 'polite');
    element.setAttribute?.('aria-label', '女仆提示：点击右侧标记展开请求预览');
    element.setAttribute?.('aria-hidden', 'true');

    const avatar = documentRef.createElement('span');
    avatar.className = 'preset-preview-discovery-guide-avatar';
    avatar.classList?.add?.('preset-preview-discovery-guide-avatar');
    avatar.setAttribute?.('aria-hidden', 'true');
    applyMaidGuideExpression(avatar, 'point');

    const copy = documentRef.createElement('span');
    copy.className = 'preset-preview-discovery-guide-copy';
    copy.classList?.add?.('preset-preview-discovery-guide-copy');
    copy.textContent = '点这里展开预览';

    const arrow = documentRef.createElement('span');
    arrow.className = 'preset-preview-discovery-guide-arrow';
    arrow.classList?.add?.('preset-preview-discovery-guide-arrow');
    arrow.setAttribute?.('aria-hidden', 'true');
    arrow.textContent = '☞';

    element.appendChild(avatar);
    element.appendChild(copy);
    element.appendChild(arrow);
    documentRef.body.appendChild(element);
    return element;
  };

  const position = () => {
    if (!element || !target || element.style?.display === 'none') return false;
    const targetRect = target.getBoundingClientRect?.();
    if (!targetRect) return false;
    const markerRect = element.getBoundingClientRect?.() || {};
    const visualViewport = windowRef?.visualViewport || null;
    const next = calculatePresetPreviewDiscoveryPosition({
      targetRect,
      markerSize: {
        width: Number(markerRect.width) || DEFAULT_MARKER_WIDTH,
        height: Number(markerRect.height) || DEFAULT_MARKER_HEIGHT,
      },
      viewport: {
        width: Number(visualViewport?.width) || Number(windowRef?.innerWidth) || 0,
        height: Number(visualViewport?.height) || Number(windowRef?.innerHeight) || 0,
      },
    });
    element.style.left = `${next.left}px`;
    element.style.top = `${next.top}px`;
    return true;
  };

  const schedulePosition = () => {
    if (frameId && typeof windowRef?.cancelAnimationFrame === 'function') {
      windowRef.cancelAnimationFrame(frameId);
    }
    if (typeof windowRef?.requestAnimationFrame === 'function') {
      frameId = windowRef.requestAnimationFrame(() => {
        frameId = 0;
        position();
      });
      return;
    }
    position();
  };

  const bindListeners = () => {
    if (listenersBound) return;
    listenersBound = true;
    windowRef?.addEventListener?.('resize', schedulePosition);
    windowRef?.addEventListener?.('scroll', schedulePosition, true);
    windowRef?.visualViewport?.addEventListener?.('resize', schedulePosition);
    windowRef?.visualViewport?.addEventListener?.('scroll', schedulePosition);
  };

  const unbindListeners = () => {
    if (!listenersBound) return;
    listenersBound = false;
    windowRef?.removeEventListener?.('resize', schedulePosition);
    windowRef?.removeEventListener?.('scroll', schedulePosition, true);
    windowRef?.visualViewport?.removeEventListener?.('resize', schedulePosition);
    windowRef?.visualViewport?.removeEventListener?.('scroll', schedulePosition);
  };

  const hide = () => {
    if (frameId && typeof windowRef?.cancelAnimationFrame === 'function') {
      windowRef.cancelAnimationFrame(frameId);
    }
    frameId = 0;
    target?.classList?.remove?.('is-opaque');
    target = null;
    if (element) {
      element.style.display = 'none';
      element.setAttribute?.('aria-hidden', 'true');
    }
    unbindListeners();
    return true;
  };

  return {
    show(nextTarget = null) {
      if (!nextTarget || isDismissed()) {
        hide();
        return false;
      }
      const marker = ensureElement();
      if (!marker) return false;
      if (target && target !== nextTarget) target.classList?.remove?.('is-opaque');
      target = nextTarget;
      target.classList?.add?.('is-opaque');
      marker.style.display = 'flex';
      marker.setAttribute?.('aria-hidden', 'false');
      bindListeners();
      schedulePosition();
      return true;
    },
    hide,
    complete() {
      if (isDismissed()) {
        hide();
        return false;
      }
      completed = true;
      let persisted = true;
      try {
        if (typeof guideStore?.dismissHint === 'function') {
          persisted = guideStore.dismissHint(PRESET_PREVIEW_DISCOVERY_HINT_ID) !== false;
        }
      } catch {
        persisted = false;
      }
      hide();
      return persisted;
    },
    getElement: () => element,
    isVisible: () => Boolean(element && element.style?.display !== 'none'),
    destroy() {
      hide();
      element?.remove?.();
      element = null;
    },
  };
};
