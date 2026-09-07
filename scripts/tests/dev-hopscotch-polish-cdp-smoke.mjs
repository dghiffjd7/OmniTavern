// 原 AC 视觉组件，隔离内存板；主题仅临时应用 DOM，结束恢复，不保存设置。
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createWsClient, findAppPageTarget, evaluateInApp } from '../dev/cdp-client.mjs';

const output = mkdtempSync('.hopscotch-polish-');
const page = await findAppPageTarget(), pending = new Map();
let socket, sequence = 0;
await new Promise((resolve, reject) => {
  socket = createWsClient(page.webSocketDebuggerUrl, { onOpen: resolve, onError: reject, onMessage: raw => {
    const message = JSON.parse(raw), item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    if (message.error) item.reject(new Error(JSON.stringify(message.error))); else item.resolve(message.result);
  } });
});
const command = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
});
const screenshot = async name => {
  const shot = await command('Page.captureScreenshot', { format: 'png' });
  writeFileSync(output + '/' + name + '.png', Buffer.from(shot.data, 'base64'));
};
try {
  await evaluateInApp(`(async () => {
    for (let i = 0; i < 100 && !window.appBridge?.debugUiRegistry?.stores?.hopscotchBoardPanel; i++) await new Promise(resolve => setTimeout(resolve, 100));
    const registry = window.appBridge.debugUiRegistry;
    if (registry.panels.agentCenterPanel.hide() === false) throw new Error('真实 AC 有草稿，停止烟测');
    const { AgentCenterPanel } = await import('/scripts/ui/agent-center-panel.js');
    const { createHopscotchBoardPanel } = await import('/scripts/ui/chat/hopscotch-board-panel.js');
    const { createHopscotchBoardStore } = await import('/scripts/storage/hopscotch-board-store.js');
    const { createHopscotchTurnRuntime } = await import('/scripts/ui/chat/hopscotch-turn-runtime.js');
    const { themeManager } = await import('/scripts/ui/theme-manager.js');
    const local = new Map();
    const store = createHopscotchBoardStore({ storage: { getItem: k => local.get(k), setItem: (k, v) => local.set(k, v) } });
    await store.setGlobalBoard({ rows: [{ houses: [{ id: 'analysis', kind: 'custom_prompt', label: '构思' }] }, { houses: [{ id: 'body', kind: 'body', fused: ['image_prompt', 'variable'] }] }, { houses: [{ id: 'memory', kind: 'memory_table' }, { id: 'image', kind: 'image_generation' }] }] });
    let board;
    const runtime = createHopscotchTurnRuntime({ boardStore: store });
    const ac = new AgentCenterPanel({ getHopscotchPanel: () => board });
    board = createHopscotchBoardPanel({ embedded: true, boardStore: store, runtime, getSessionId: () => 'rp:polish-smoke', getProfiles: () => [{ id: 'p1', name: 'Model profile with a longer name for narrow screens' }], mountAgentCard: (host, options) => ac.mountHopscotchAgentCard(host, options) });
    window.__hopPolish = { ac, board, theme: themeManager.resolveCurrentTheme() };
    ac.show(); await ac.refresh();
  })()`);
  for (const theme of ['paper-ink', 'classic-light', 'classic-dark']) {
    await evaluateInApp(`(async () => {
      const { themeManager } = await import('/scripts/ui/theme-manager.js');
      const { themeStore } = await import('/scripts/storage/theme-store.js');
      themeManager.applyThemePreset({ preset: themeStore.getTheme(${JSON.stringify(theme)}) });
    })()`);
    for (const width of [1200, 390, 320]) {
      await command('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: false });
      const metrics = await evaluateInApp(`(async () => {
        const root = window.__hopPolish.ac.contentElement.querySelector('.hop-embedded');
        root.querySelector('.hop-board-toolbar').scrollIntoView({ block: 'start' });
        await new Promise(resolve => setTimeout(resolve, 400));
        const cells = [...root.querySelectorAll('[data-hop-house]')];
        const centers = [...root.querySelectorAll('.hop-gap, .hop-row, .hop-roof')].map(n => { const r = n.getBoundingClientRect(); return r.left + r.width / 2; });
        const button = root.querySelector('.hop-scope .world-app-select-btn'), r = button.getBoundingClientRect();
        return { width: innerWidth, cellStyles: cells.map(n => ({ kind: n.dataset.hopKind, gradient: getComputedStyle(n).backgroundImage, shadow: getComputedStyle(n).boxShadow })), spread: Math.max(...centers) - Math.min(...centers), x: r.left + r.width / 2, y: r.top + r.height / 2, label: button.getAttribute('aria-label') };
      })()`);
      assert.ok(metrics.cellStyles.every(s => s.gradient.includes('radial-gradient') && s.shadow !== 'none'));
      assert.ok(metrics.spread < 1, '上下行加号偏离中轴');
      assert.equal(metrics.label, '保存范围');
      await command('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, x: metrics.x, y: metrics.y });
      await command('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x: metrics.x, y: metrics.y });
      const menu = await evaluateInApp(`(async () => {
        const menu = document.querySelector('.world-app-select-menu');
        await Promise.all(menu.getAnimations({ subtree: true }).filter(a => a.effect.getComputedTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})));
        const r = menu.getBoundingClientRect();
        return { visible: menu.style.display !== 'none', left: r.left, right: r.right, top: r.top, bottom: r.bottom, hit: menu.contains(document.elementFromPoint(r.left + 20, r.top + 20)), selected: menu.querySelector('.is-selected')?.textContent.trim() };
      })()`);
      assert.ok(menu.visible && menu.hit && menu.selected);
      assert.ok(menu.left >= 0 && menu.right <= width && menu.top >= 0 && menu.bottom <= 844);
      await screenshot(theme + '-' + width);
      await evaluateInApp(`(async () => { (await import('/scripts/ui/custom-select.js')).closeCustomSelectMenu(); })()`);
      const cellPoint = await evaluateInApp(`(() => { const r = window.__hopPolish.ac.contentElement.querySelector('[data-hop-house]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      await command('Input.dispatchMouseEvent', { type: 'mouseMoved', ...cellPoint });
      const hoverFill = await evaluateInApp(`getComputedStyle(window.__hopPolish.ac.contentElement.querySelector('[data-hop-house]')).backgroundImage`);
      assert.ok(hoverFill.includes('radial-gradient'), '悬停不应被通用按钮样式覆盖成平涂');
      await evaluateInApp(`(async () => {
        const root = window.__hopPolish.ac.contentElement.querySelector('.hop-embedded');
        root.querySelector('[data-hop-house="analysis"]').click();
        const detail = document.querySelector('.hop-house-detail[open]');
        detail.querySelector('.agent-center-floating-face-front [data-agent-float-flip]').click();
        detail.querySelector('details').open = true;
        await new Promise(resolve => setTimeout(resolve, 350));
        const select = detail.querySelector('[name="model"]');
        const button = select.closest('.hop-select').querySelector('button');
        button.scrollIntoView({ block: 'center' });
        // 滚动会按公共组件规则关闭菜单；等布局稳定后再模拟点击。
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        button.click();
      })()`);
      const fieldMenu = await evaluateInApp(`(async () => {
        const detail = document.querySelector('.hop-house-detail[open]'), back = detail.querySelector('.agent-center-floating-face-back');
        const menu = document.querySelector('.world-app-select-menu');
        await Promise.all([...menu.getAnimations({ subtree: true }), ...detail.getAnimations({ subtree: true })].filter(a => a.effect.getComputedTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})));
        const r = menu.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, hit: menu.contains(document.elementFromPoint(r.left + 20, r.top + 20)), overflow: back.scrollWidth - back.clientWidth };
      })()`);
      assert.ok(fieldMenu.hit && fieldMenu.left >= 0 && fieldMenu.right <= width && fieldMenu.top >= 0 && fieldMenu.bottom <= 844 && fieldMenu.overflow <= 1, JSON.stringify(fieldMenu));
      await screenshot(theme + '-field-' + width);
      await evaluateInApp(`(() => { window.__hopPolish.board.closeTopLayer(); window.__hopPolish.board.closeTopLayer(); })()`);
      console.log('ok - themed house texture, centered plus and original dropdown bounds/hit testing', { theme, width });
    }
  }
  console.log('screenshots:', output);
} finally {
  await evaluateInApp(`(async () => {
    const fixture = window.__hopPolish;
    if (!fixture) return;
    const { themeManager } = await import('/scripts/ui/theme-manager.js');
    themeManager.applyThemePreset(fixture.theme); fixture.ac.destroy(); fixture.board.dispose(); delete window.__hopPolish;
    window.appBridge.debugUiRegistry.panels.agentCenterPanel.show();
  })()`);
  await command('Emulation.clearDeviceMetricsOverride'); socket.close();
}
