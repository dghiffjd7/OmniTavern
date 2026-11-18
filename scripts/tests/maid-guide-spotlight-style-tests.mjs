import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  advanceMaidSpotlightBox,
  calculateMaidSpotlightLayout,
  isMaidGuideMotionReduced,
  isMaidGuideTargetOutsideViewport,
  resolveMaidSpotlightMaskGeometry,
} from '../../src/scripts/ui/maid-guide-spotlight.js';

const source = fs.readFileSync(
  new URL('../../src/scripts/ui/maid-guide-spotlight.js', import.meta.url),
  'utf8',
);

{
  assert.match(source, /z-index:\s*40000/);
  assert.match(source, /maid-spotlight-dim-top/);
  assert.match(source, /maid-spotlight-dim-bottom/);
  assert.match(source, /maid-spotlight-dim-left/);
  assert.match(source, /maid-spotlight-dim-right/);
  assert.match(source, /@keyframes\s+maid-spotlight-ring-pulse/);
  assert.match(source, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.match(source, /body\[data-reduced-motion=['"]on['"]\]\s+\.maid-spotlight-root/);
  assert.match(source, /var\(--app-accent-primary/);
  assert.match(source, /var\(--app-success-text/);
  assert.match(source, /scrollIntoView\?\.\(/);
  assert.match(source, /index > 0 && typeof current\?\.onPrev === 'function'/);
  assert.match(source, /maid-spotlight-arrow/);
  assert.match(source, /maid-spotlight-escape-hint/);
  assert.match(source, /maid-spotlight-card-avatar-status/);
  assert.match(source, /applyMaidGuideExpression/);
  assert.match(source, /resolveMaidGuideExpressionState/);
  assert.match(source, /maid-spotlight-done-avatar/);
  assert.match(source, /applyMaidGuideExpression\(avatar, 'complete'\)/);
  assert.match(source, /\.maid-spotlight-card-avatar-wrap\s*\{[\s\S]*?width:\s*50px;[\s\S]*?height:\s*50px;[\s\S]*?flex:\s*0 0 50px;/);
  assert.match(source, /\.maid-spotlight-card-avatar\s*\{[\s\S]*?width:\s*50px;[\s\S]*?height:\s*50px;/);
  assert.match(source, /\.maid-spotlight-done-avatar\s*\{[\s\S]*?width:\s*72px;[\s\S]*?height:\s*72px;/);
  assert.match(source, /step\.primaryLabel \|\| '帮主人来'/);
  assert.doesNotMatch(source, /maid-spotlight-status/);
  assert.doesNotMatch(source, /statusAvatarEl/);
  assert.doesNotMatch(source, /maid-tumble\.webp/);
  assert.match(source, /overflow-y:\s*auto/);
  assert.match(source, /cardEl\?\.scrollHeight/);
  assert.match(source, /const applyCardBox/);
  assert.match(source, /applyStyleValue\(element, 'height', 'auto'\)/);
  assert.doesNotMatch(source, /applyBox\(cardEl,\s*layout\.card\)/);
  assert.match(source, /maid-spotlight-card:not\(\.is-typed\)\s+\.maid-spotlight-text::after/);
  assert.match(source, /\.maid-spotlight-root\.is-rendering\.is-opening\s+\.maid-spotlight-card/);
  assert.match(source, /\.maid-spotlight-root\.is-rendering\.is-stepping\s+\.maid-spotlight-card/);
  assert.match(source, /@keyframes\s+maid-spotlight-card-step-in\s*\{\s*from\s*\{(?![^}]*opacity:\s*0)/);
  assert.match(source, /textEl\.style\.minHeight\s*=\s*`\$\{reservedTextHeight\}px`/);
  assert.match(source, /\.maid-spotlight-hint\.has-text\s*\{[\s\S]*?visibility:\s*hidden/);
  const geometryCss = source.slice(
    source.indexOf('.maid-spotlight-dim {'),
    source.indexOf('.maid-spotlight-escape-hint {'),
  );
  assert.doesNotMatch(geometryCss, /transition:[^;]*(?:left|top|width|height)/);
  assert.doesNotMatch(source, /is-tracking|firstGeometryRefresh|targetTrackingDeadline|targetGeometryTransitionDeadline|directTargetTracking/);
  assert.match(source, /let initialResizeDelivery = true/);
  assert.match(source, /if \(initialResizeDelivery\)[\s\S]*?if \(!targetGeometryChanged\) return/);
  assert.match(source, /const TARGET_RESOLVE_GRACE_MS = 1000/);
  assert.match(source, /const TARGET_RESOLVE_RETRY_MS = 100/);
  // 目标每次成功解析都滑动续期宽限，避免步内目标消失时闪一帧全屏 dim
  assert.match(source, /if \(target\) targetResolveDeadline = Date\.now\(\) \+ TARGET_RESOLVE_GRACE_MS;/);
  assert.match(source, /const GEOMETRY_FOLLOW_TIME_CONSTANT_MS = 90/);
  assert.match(source, /let renderedHole/);
  assert.match(source, /let geometryStableFrames/);
  assert.match(source, /expectsTarget\s*=\s*null/);
  assert.match(source, /expectsTarget:\s*expectsTarget == null[\s\S]*?Boolean\(String\(steps\[safeIndex\]\?\.target/);
  assert.match(source, /const expectsTarget = current\.phase !== 'done' && current\.expectsTarget === true/);
  assert.match(
    source,
    /expectsTarget && !target && Date\.now\(\) < targetResolveDeadline[\s\S]*?applyCardBox\(cardEl, lastLayout\.card\)[\s\S]*?scheduleTargetRetry\(\)[\s\S]*?return/,
  );
  assert.match(source, /advanceMaidSpotlightBox\(\{[\s\S]*?current:\s*renderedHole[\s\S]*?target:\s*destinationHole/);
  assert.match(source, /if \(!geometrySettled\) scheduleRefresh\(\)/);
  assert.match(source, /if \(element\.style\[property\] !== value\) element\.style\[property\] = value/);
  assert.match(source, /const resetGeometry = \(\) => \{[\s\S]*?renderedHole = \{ left: 0, top: 0, width: 0, height: 0 \}[\s\S]*?applyBox\(dims\[0\], full\)[\s\S]*?applyBox\(holeEl, renderedHole\)/);
  assert.ok((source.match(/resetGeometry\(\);/g) || []).length >= 2, 'geometry must reset both on first mount and after hide');
  assert.ok((source.match(/clearTargetRetryTimer\(\);/g) || []).length >= 3);
  console.log('ok - maid spotlight keeps one step indicator, four-pane masking, app tokens, and dual reduced-motion channels');
}

{
  const from = { left: 120, top: 457, width: 100, height: 60 };
  const first = advanceMaidSpotlightBox({
    current: from,
    target: { left: 120, top: 800, width: 100, height: 60 },
    deltaMs: 16.67,
  });
  assert.equal(first.settled, false);
  assert.ok(first.box.top > 457 && first.box.top < 800, 'travel must advance without snapping to its destination');

  const moving = advanceMaidSpotlightBox({
    current: first.box,
    target: { left: 120, top: 718, width: 100, height: 60 },
    deltaMs: 16.67,
  });
  assert.ok(moving.box.top > first.box.top && moving.box.top < 718, 'a moving target must stay on the same smooth pursuit channel');

  let state = { left: 0, top: 0, width: 0, height: 0 };
  let settled = false;
  for (let frame = 0; frame < 120 && !settled; frame += 1) {
    const next = advanceMaidSpotlightBox({
      current: state,
      target: { left: 600, top: 400, width: 80, height: 44 },
      deltaMs: 16.67,
    });
    state = next.box;
    settled = next.settled;
  }
  assert.equal(settled, true);
  assert.deepEqual(state, { left: 600, top: 400, width: 80, height: 44 });

  const reduced = advanceMaidSpotlightBox({
    current: from,
    target: { left: 120, top: 800, width: 100, height: 60 },
    deltaMs: 16.67,
    reducedMotion: true,
  });
  assert.equal(reduced.settled, true);
  assert.deepEqual(reduced.box, { left: 120, top: 800, width: 100, height: 60 });
  console.log('ok - maid spotlight uses one smooth geometry channel for travel and moving-target pursuit');
}

{
  const devicePixelRatio = 1.5;
  const geometry = resolveMaidSpotlightMaskGeometry({
    viewport: { w: 1200, h: 800 },
    hole: {
      left: 83.127,
      top: 157.219,
      width: 218.447,
      height: 74.163,
    },
    devicePixelRatio,
  });
  const { hole, panes } = geometry;
  const right = hole.left + hole.width;
  const bottom = hole.top + hole.height;
  [hole.left, hole.top, right, bottom].forEach((edge) => {
    assert.ok(
      Math.abs(edge * devicePixelRatio - Math.round(edge * devicePixelRatio)) < 1e-9,
      `mask edge ${edge} must align to a device pixel`,
    );
  });
  assert.equal(panes.top.height, hole.top);
  assert.equal(panes.bottom.top, bottom);
  assert.equal(panes.left.top, hole.top);
  assert.equal(panes.right.top, hole.top);
  assert.ok(Math.abs(panes.left.top + panes.left.height - bottom) < 1e-9);
  assert.ok(Math.abs(panes.right.top + panes.right.height - bottom) < 1e-9);
  console.log('ok - maid spotlight mask panes share device-pixel-aligned hole edges');
}

{
  const desktop = calculateMaidSpotlightLayout({
    viewport: { w: 1200, h: 800 },
    targetRect: { left: 100, top: 100, width: 80, height: 40 },
    cardSize: { width: 384, height: 236 },
    placement: 'right',
  });
  assert.deepEqual(desktop.hole, { left: 90, top: 90, width: 100, height: 60 });
  assert.equal(desktop.placement, 'right');
  assert.ok(desktop.card.left >= desktop.hole.left + desktop.hole.width);

  const forcedBottomWithoutRoom = calculateMaidSpotlightLayout({
    viewport: { w: 1200, h: 800 },
    targetRect: { left: 520, top: 730, width: 100, height: 40 },
    cardSize: { width: 384, height: 236 },
    placement: 'bottom',
  });
  assert.equal(forcedBottomWithoutRoom.placement, 'top');
  assert.ok(
    forcedBottomWithoutRoom.card.top + forcedBottomWithoutRoom.card.height
      <= forcedBottomWithoutRoom.hole.top - 16,
    'a preferred side without room must flip instead of clamping across the target',
  );

  const mobile = calculateMaidSpotlightLayout({
    viewport: { w: 390, h: 640 },
    targetRect: { left: 330, top: 60, width: 40, height: 40 },
    cardSize: { width: 384, height: 236 },
    placement: 'right',
  });
  assert.equal(mobile.mobile, true);
  assert.equal(mobile.card.left, 12);
  assert.equal(mobile.card.width, 366);
  assert.ok(mobile.card.top + mobile.card.height <= 628);

  const mobileBottomTarget = calculateMaidSpotlightLayout({
    viewport: { w: 390, h: 640 },
    targetRect: { left: 120, top: 570, width: 150, height: 48 },
    cardSize: { width: 384, height: 236 },
    placement: 'top',
  });
  assert.equal(mobileBottomTarget.placement, 'top-fixed');
  assert.ok(
    mobileBottomTarget.card.top + mobileBottomTarget.card.height
      <= mobileBottomTarget.hole.top - 16,
    'mobile card must move above a bottom target',
  );

  const mobileLongGuide = calculateMaidSpotlightLayout({
    viewport: { w: 390, h: 720 },
    targetRect: { left: 130, top: 320, width: 130, height: 44 },
    cardSize: { width: 384, height: 420 },
    placement: 'bottom',
  });
  const mobileLongOverlap = Math.max(
    0,
    Math.min(mobileLongGuide.card.top + mobileLongGuide.card.height, mobileLongGuide.hole.top + mobileLongGuide.hole.height)
      - Math.max(mobileLongGuide.card.top, mobileLongGuide.hole.top),
  );
  assert.equal(mobileLongOverlap, 0, 'a long mobile guide must scroll within the free side instead of covering its target');
  assert.ok(mobileLongGuide.card.maxHeight < 420);

  const narrowDesktopLongGuide = calculateMaidSpotlightLayout({
    viewport: { w: 600, h: 600 },
    targetRect: { left: 240, top: 270, width: 120, height: 40 },
    cardSize: { width: 384, height: 500 },
    placement: 'bottom',
  });
  const desktopLongOverlap = Math.max(
    0,
    Math.min(narrowDesktopLongGuide.card.top + narrowDesktopLongGuide.card.height, narrowDesktopLongGuide.hole.top + narrowDesktopLongGuide.hole.height)
      - Math.max(narrowDesktopLongGuide.card.top, narrowDesktopLongGuide.hole.top),
  );
  assert.equal(desktopLongOverlap, 0, 'a tall desktop guide must use a constrained non-overlapping side when one is readable');

  const placementMatrix = [
    { viewport: { w: 320, h: 568 }, targetRect: { left: 8, top: 24, width: 64, height: 44 }, cardHeight: 480 },
    { viewport: { w: 320, h: 568 }, targetRect: { left: 118, top: 250, width: 84, height: 44 }, cardHeight: 480 },
    { viewport: { w: 320, h: 568 }, targetRect: { left: 210, top: 500, width: 84, height: 44 }, cardHeight: 480 },
    { viewport: { w: 390, h: 720 }, targetRect: { left: 120, top: 330, width: 150, height: 48 }, cardHeight: 620 },
    { viewport: { w: 600, h: 600 }, targetRect: { left: 240, top: 270, width: 120, height: 40 }, cardHeight: 650 },
    { viewport: { w: 1200, h: 800 }, targetRect: { left: 540, top: 360, width: 120, height: 48 }, cardHeight: 740 },
  ];
  placementMatrix.forEach(({ viewport, targetRect, cardHeight }) => {
    const layout = calculateMaidSpotlightLayout({
      viewport,
      targetRect,
      cardSize: { width: 384, height: cardHeight },
      placement: 'bottom',
    });
    const card = layout.card;
    const hole = layout.hole;
    const overlapWidth = Math.max(
      0,
      Math.min(card.left + card.width, hole.left + hole.width) - Math.max(card.left, hole.left),
    );
    const overlapHeight = Math.max(
      0,
      Math.min(card.top + card.height, hole.top + hole.height) - Math.max(card.top, hole.top),
    );
    assert.equal(overlapWidth * overlapHeight, 0, `${viewport.w}x${viewport.h} guide card must not cover its target`);
    assert.ok(card.left >= 0 && card.top >= 0, `${viewport.w}x${viewport.h} guide card must start inside the viewport`);
    assert.ok(card.left + card.width <= viewport.w, `${viewport.w}x${viewport.h} guide card must fit horizontally`);
    assert.ok(card.top + card.height <= viewport.h, `${viewport.w}x${viewport.h} guide card must fit vertically`);
  });
  console.log('ok - maid spotlight layout flips desktop sides and docks mobile cards away from their target');
}

{
  assert.equal(isMaidGuideMotionReduced({
    body: { dataset: { reducedMotion: 'on' } },
  }, () => ({ matches: false })), true);
  assert.equal(isMaidGuideMotionReduced({
    body: { dataset: {} },
  }, () => ({ matches: true })), true);
  assert.equal(isMaidGuideMotionReduced({
    body: { dataset: {} },
  }, () => ({ matches: false })), false);
  console.log('ok - maid spotlight JS motion check follows app and OS settings');
}

{
  const viewport = { w: 390, h: 640 };
  assert.equal(isMaidGuideTargetOutsideViewport({
    rect: { left: 20, top: 100, right: 120, bottom: 140 },
    viewport,
  }), false);
  assert.equal(isMaidGuideTargetOutsideViewport({
    rect: { left: 20, top: 700, right: 120, bottom: 740 },
    viewport,
  }), true);
  assert.equal(isMaidGuideTargetOutsideViewport({
    rect: { left: 10, top: -300, right: 380, bottom: 40 },
    viewport,
  }), false, 'partially visible composite targets should not force-scroll');
  console.log('ok - maid spotlight scrolls only targets that are fully outside the viewport');
}
