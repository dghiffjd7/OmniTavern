import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createWsClient, findAppPageTarget, evaluateInApp } from './cdp-client.mjs';

const page = await findAppPageTarget();
let sequence = 0;
const pending = new Map();
let socket;
await new Promise((resolve, reject) => {
  socket = createWsClient(page.webSocketDebuggerUrl, {
    onOpen: resolve, onError: reject,
    onMessage: raw => {
      const message = JSON.parse(raw);
      const item = pending.get(message.id);
      if (!item) return;
      pending.delete(message.id);
      if (message.error) item.reject(new Error(JSON.stringify(message.error)));
      else item.resolve(message.result);
    },
  });
});
const command = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence;
  pending.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method, params }));
});
try {
  for (const width of [1200, 390, 320]) {
    await command('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: false });
    await evaluateInApp(`new Promise(resolve => setTimeout(resolve, 300))`);
    await evaluateInApp(`(async () => {
      const panel = window.__agentCenterMigrationSmoke?.root || window.__agentCenterHopscotchSmoke?.root || document.querySelector('dialog.hop-dialog[open]');
      const surface = panel.closest('.agent-center-panel') || panel;
      await Promise.all(surface.getAnimations({ subtree: true }).filter(a => a.effect.getComputedTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})));
    })()`);
    const toolbar = await evaluateInApp(`(() => {
      const panel = window.__agentCenterMigrationSmoke?.root || window.__agentCenterHopscotchSmoke?.root || document.querySelector('dialog.hop-dialog[open]');
      panel.querySelector('.hop-board-toolbar').scrollIntoView({ block: 'start' });
      const r = panel.getBoundingClientRect();
      const footer = panel.querySelector('.hop-board-footer');
      const save = footer.querySelector('.hop-primary');
      const s = getComputedStyle(save);
      const controls = [...panel.querySelectorAll('.hop-controls .world-app-select-btn, .hop-controls select:not([hidden]), [data-action="more"], [data-action="library"], .hop-board-footer > .hop-primary')].map(node => {
        const b = node.getBoundingClientRect(); return { left: b.left, right: b.right, height: b.height };
      });
      const help = panel.querySelector('[data-action="help"]');
      return { left: r.left, right: r.right, controls, modeButtons: panel.querySelectorAll('[data-action="more"], [data-action="library"]').length,
        helpLabel: help.getAttribute('aria-label'), helpTitle: help.title, saveFont: s.fontSize, saveRadius: s.borderRadius,
        saveWidth: save.getBoundingClientRect().width, footerWidth: footer.getBoundingClientRect().width, saveHeight: save.getBoundingClientRect().height, saveMinHeight: s.minHeight };
    })()`);
    assert.equal(toolbar.modeButtons, 2);
    assert.ok(toolbar.helpLabel && toolbar.helpTitle);
    assert.equal(toolbar.saveFont, '12px');
    assert.equal(toolbar.saveRadius, '10px');
    assert.ok(toolbar.controls.every(r => r.left >= toolbar.left - 1 && r.right <= toolbar.right + 1), `toolbar/footer overflow: ${JSON.stringify(toolbar)}`);
    if (width <= 600) {
      assert.equal(toolbar.saveMinHeight, '44px');
      assert.ok(toolbar.saveHeight >= 43.5, JSON.stringify(toolbar));
      assert.ok(Math.abs(toolbar.saveWidth - toolbar.footerWidth) < 1, 'embedded mobile save must fill the footer');
    }
    const toolbarScreenshot = await command('Page.captureScreenshot', { format: 'png' });
    writeFileSync(`.hopscotch-toolbar-${width}.png`, Buffer.from(toolbarScreenshot.data, 'base64'));
    console.log('ok - grouped controls, accessible icons and responsive footer', { width, ...toolbar });
    const metrics = await evaluateInApp(`(() => {
      const panel = window.__agentCenterMigrationSmoke?.root || window.__agentCenterHopscotchSmoke?.root || document.querySelector('dialog.hop-dialog[open]');
      const rect = panel.getBoundingClientRect();
      const footer = panel.querySelector('.hop-footer');
      footer.scrollIntoView({ block: 'end' });
      const centers = [...panel.querySelectorAll('.hop-gap, .hop-row, .hop-roof')].map(node => { const r = node.getBoundingClientRect(); return r.left + r.width / 2; });
      const primary = getComputedStyle(panel.querySelector('.hop-primary'));
      return { width: innerWidth, left: rect.left, right: rect.right, dialogWidth: rect.width, footerWidth: footer.getBoundingClientRect().width, cells: panel.querySelectorAll('.hop-cell').length, gapCount: panel.querySelectorAll('.hop-gap').length, centerSpread: Math.max(...centers) - Math.min(...centers), primary: { foreground: primary.color, background: primary.backgroundColor, accent: primary.getPropertyValue('--app-accent-primary') } };
    })()`);
    assert.ok(metrics.left >= -1 && metrics.right <= width + 1, `dialog outside viewport: ${JSON.stringify(metrics)}`);
    assert.ok(metrics.footerWidth <= metrics.dialogWidth);
    assert.ok(metrics.cells >= 3);
    assert.ok(metrics.centerSpread < 1, `inter-row plus not centered: ${JSON.stringify(metrics)}`);
    assert.notEqual(metrics.primary.background, 'rgba(0, 0, 0, 0)', 'primary action must have a visible fill');
    const screenshot = await command('Page.captureScreenshot', { format: 'png' });
    writeFileSync(`.hopscotch-${width}.png`, Buffer.from(screenshot.data, 'base64'));
    console.log('ok - responsive board geometry', metrics);
    const card = await evaluateInApp(`(async () => {
      const fixture = window.__agentCenterMigrationSmoke;
      const panel = fixture?.root || window.__agentCenterHopscotchSmoke?.root || document.querySelector('dialog.hop-dialog[open]');
      if (fixture) await fixture.openShared('review');
      else panel.querySelector('[data-hop-house]').click();
      const detail = document.querySelector('.hop-house-detail[open]');
      if (!fixture) detail.querySelector('[data-action="flip"]').click();
      await new Promise(resolve => setTimeout(resolve, 400));
      const surface = detail.querySelector('.agent-center-floating-card') || detail;
      const rect = surface.getBoundingClientRect();
      const back = detail.querySelector('.agent-center-floating-face-back, .hop-card-back');
      const name = back.querySelector('[name="label"], [data-agent-feature-model-override]');
      name?.focus();
      return { left: rect.left, right: rect.right, bottom: rect.bottom, top: rect.top, backInert: back.inert, frontInert: detail.querySelector('.agent-center-floating-face-front, .hop-card-front').inert, focusOnBack: name ? document.activeElement === name : true, gradient: getComputedStyle(surface, '::before').backgroundImage, previewVisible: fixture ? !!back.querySelector('[data-agent-prompt-preview]')?.getClientRects().length : true };
    })()`);
    assert.ok(card.left >= -1 && card.right <= width + 1 && card.top >= -1 && card.bottom <= 845, `card outside viewport: ${JSON.stringify(card)}`);
    assert.equal(card.backInert, false);
    assert.equal(card.frontInert, true);
    assert.equal(card.focusOnBack, true);
    assert.equal(card.previewVisible, true);
    const cardScreenshot = await command('Page.captureScreenshot', { format: 'png' });
    writeFileSync(`.hopscotch-card-${width}.png`, Buffer.from(cardScreenshot.data, 'base64'));
    const originalFront = await evaluateInApp(`(async () => {
      const detail = document.querySelector('.hop-house-detail[open]');
      const back = detail.querySelector('.agent-center-floating-face-back');
      if (!back) return null;
      back.querySelector('[data-agent-float-flip]').click();
      await new Promise(resolve => setTimeout(resolve, 300));
      const front = detail.querySelector('.agent-center-floating-face-front');
      return { frontInert: front.inert, backInert: back.inert, badge: !!front.querySelector('.agent-center-agent-badge'), sections: front.querySelectorAll('.agent-center-agent-section').length };
    })()`);
    if (originalFront) {
      assert.ok(!originalFront.frontInert && originalFront.backInert && originalFront.badge && originalFront.sections > 0, 'original detailed front must survive the return flip');
      const frontScreenshot = await command('Page.captureScreenshot', { format: 'png' });
      writeFileSync(`.hopscotch-front-${width}.png`, Buffer.from(frontScreenshot.data, 'base64'));
    }
    await evaluateInApp(`(() => { const detail = document.querySelector('.hop-house-detail[open]'); (detail.querySelector('.agent-center-floating-face:not([inert]) [data-agent-float-close]') || detail.querySelector('[data-action="close-detail"]')).click(); })()`);
    console.log('ok - floating card back, focus and viewport', card);
    const catalog = await evaluateInApp(`(async () => {
      const fixture = window.__agentCenterMigrationSmoke;
      if (!fixture) return null;
      const library = fixture.ac.contentElement.querySelector('[data-agent-library]');
      library.open = true;
      library.scrollIntoView({ block: 'end' });
      await new Promise(resolve => setTimeout(resolve, 100));
      const rect = library.getBoundingClientRect();
      return { left: rect.left, right: rect.right, count: library.querySelectorAll('.hop-agent-tile').length };
    })()`);
    if (catalog) {
      assert.ok(catalog.left >= -1 && catalog.right <= width + 1 && catalog.count >= 5);
      const shelfScreenshot = await command('Page.captureScreenshot', { format: 'png' });
      writeFileSync(`.hopscotch-shelf-${width}.png`, Buffer.from(shelfScreenshot.data, 'base64'));
      const legacy = await evaluateInApp(`(async () => {
        const ac = window.__agentCenterMigrationSmoke.ac;
        ac.openFloatingAgentCard('image_director'); ac.toggleFloatingAgentCard();
        await new Promise(resolve => setTimeout(resolve, 450));
        const card = ac.contentElement.querySelector('.agent-center-floating-card');
        const r = card.getBoundingClientRect();
        const face = card.querySelector('.agent-center-floating-face-back');
        const textarea = face.querySelector('textarea');
        textarea.focus();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, faceTransform: getComputedStyle(face).transform, gradient: getComputedStyle(card, '::before').backgroundImage, active: document.activeElement === textarea };
      })()`);
      assert.ok(legacy.left >= -1 && legacy.right <= width + 1 && legacy.top >= -1 && legacy.bottom <= 845, `catalog card bounds ${JSON.stringify(legacy)}`);
      assert.equal(legacy.active, true);
      assert.equal(legacy.faceTransform, 'matrix(1, 0, 0, 1, 0, 0)', 'use original card face transition without mirroring');
      assert.ok(legacy.gradient.includes('linear-gradient') && card.gradient.includes('linear-gradient'), 'house and catalog must preserve original gradient surface');
      const legacyScreenshot = await command('Page.captureScreenshot', { format: 'png' });
      writeFileSync(`.hopscotch-agent-${width}.png`, Buffer.from(legacyScreenshot.data, 'base64'));
      await evaluateInApp(`window.__agentCenterMigrationSmoke.ac.closeFloatingAgentCard()`);
      console.log('ok - compact shelf and unified Agent card', catalog, legacy);
    }
  }
  // 仅暂时应用 DOM 主题，不调用设置保存；无论断言结果如何都恢复原主题。
  await evaluateInApp(`(async () => {
    const { themeManager } = await import('/scripts/ui/theme-manager.js');
    window.__hopVisualTheme = themeManager.resolveCurrentTheme();
    const { themeStore } = await import('/scripts/storage/theme-store.js');
    themeManager.applyThemePreset({ preset: themeStore.getTheme('classic-dark') });
  })()`);
  for (const width of [1200, 390]) {
    await command('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: false });
    const theme = await evaluateInApp(`(async () => {
      const panel = window.__agentCenterMigrationSmoke?.root || window.__agentCenterHopscotchSmoke?.root || document.querySelector('dialog.hop-dialog[open]');
      panel.querySelector('.hop-board-toolbar').scrollIntoView({ block: 'start' });
      await new Promise(resolve => setTimeout(resolve, 300));
      const { parseCssColor, contrastRatio } = await import('/scripts/ui/theme-dark-audit.js');
      return { mode: document.body.dataset.themeMode, controls: ['.hop-cell:not(.hop-body)', '[data-action="save"]', '.hop-scope .world-app-select-btn, .hop-scope select:not([hidden])'].map(selector => {
        const s = getComputedStyle(panel.querySelector(selector));
        return { selector, foreground: s.color, background: s.backgroundColor, contrast: contrastRatio(parseCssColor(s.color), parseCssColor(s.backgroundColor)) };
      }) };
    })()`);
    assert.equal(theme.mode, 'dark');
    assert.ok(theme.controls.every(control => control.contrast >= 4.5), `dark contrast: ${JSON.stringify(theme)}`);
    const screenshot = await command('Page.captureScreenshot', { format: 'png' });
    writeFileSync(`.hopscotch-dark-${width}.png`, Buffer.from(screenshot.data, 'base64'));
    console.log('ok - dark board and control contrast', { width, ...theme });
  }
} finally {
  await evaluateInApp(`(async () => { if (!window.__hopVisualTheme) return; const { themeManager } = await import('/scripts/ui/theme-manager.js'); themeManager.applyThemePreset(window.__hopVisualTheme); delete window.__hopVisualTheme; })()`);
  await command('Emulation.clearDeviceMetricsOverride');
  socket.close();
}
