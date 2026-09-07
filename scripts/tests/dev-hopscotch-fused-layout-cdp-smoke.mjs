// 真实 AC / 当前配置：只打开、翻面、返回；不点击保存或开关。
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createWsClient, findAppPageTarget, evaluateInApp } from '../dev/cdp-client.mjs';

const page = await findAppPageTarget();
const pending = new Map();
let sequence = 0, socket;
await new Promise((resolve, reject) => {
  socket = createWsClient(page.webSocketDebuggerUrl, { onOpen: resolve, onError: reject, onMessage: raw => {
    const message = JSON.parse(raw), item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    if (message.error) item.reject(new Error(JSON.stringify(message.error)));
    else item.resolve(message.result);
  } });
});
const command = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
});
try {
  for (const width of [1200, 390, 320]) {
    await command('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: false });
    const result = await evaluateInApp(`(async () => {
      const check = (v, message) => { if (!v) throw new Error(message); };
      const wait = () => new Promise(resolve => setTimeout(resolve, 350));
      for (let i = 0; i < 30 && !window.appBridge?.debugUiRegistry?.stores?.hopscotchBoardPanel; i++) await wait();
      const r = window.appBridge.debugUiRegistry;
      const ac = r.panels.agentCenterPanel;
      check(!r.stores.hopscotchBoardPanel.isOpen(), '已有打开的房子，停止烟测');
      ac.show(); await ac.refresh();
      await Promise.all(ac.overlayElement.getAnimations({ subtree: true }).filter(a => a.effect.getComputedTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})));
      const root = ac.contentElement.querySelector('.hop-embedded');
      check(!root.querySelector('.hop-source.is-dirty'), '真实板有草稿，停止烟测');
      const before = JSON.stringify(r.stores.hopscotchTurnRuntime.resolveBoard(r.stores.chatStore?.getCurrent?.()));
      const group = root.querySelector('.hop-fusion-group');
      check(group, '当前配置应有融合组');
      const groupRect = group.getBoundingClientRect();
      const members = [...group.querySelectorAll('[data-hop-part]')];
      const titles = members.map(n => getComputedStyle(n.querySelector('.hop-title')));
      check(groupRect.width > groupRect.height * 1.7, '融合组应为横向长方形');
      check(titles.every(s => s.fontSize === titles[0].fontSize && s.fontWeight === titles[0].fontWeight && s.color === titles[0].color), '融合标题视觉层级不等价');
      check(members.every(n => Math.abs(n.getBoundingClientRect().width - members[0].getBoundingClientRect().width) < 1), '融合成员应等宽');
      check(!group.draggable && members[0].draggable && members.slice(1).every(n => !n.draggable), '不能假装已支持成员拖出并误拖整个组');
      const centers = [...root.querySelectorAll('.hop-gap, .hop-row, .hop-roof')].map(n => { const b = n.getBoundingClientRect(); return b.left + b.width / 2; });
      check(Math.max(...centers) - Math.min(...centers) < 1, '融合组变宽后加号失去居中');
      const member = group.querySelector('[data-hop-part="memory_table"]');
      member.scrollIntoView({ block: 'center', inline: 'center' }); member.focus(); member.click(); await wait();
      let opened = document.querySelector('.hop-house-detail[open]');
      check(opened.querySelector('[data-hop-fused-config="memory_table"]').open, '融合分区未直达原配置');
      r.actions.closeTopAppLayer(); await wait();
      check(document.activeElement === member && !opened.open, '关闭应返回原分区按钮');
      root.querySelector('[data-hop-house="body"]').click(); await wait();
      const detail = document.querySelector('.hop-house-detail[open]');
      const links = [...detail.querySelectorAll('[data-hop-fused-open]')];
      check(links.length > 0, '当前设置没有融合项，无法验证');
      const card = detail.querySelector('.agent-center-floating-card');
      const bounds = card.getBoundingClientRect();
      check(bounds.left >= -1 && bounds.right <= innerWidth + 1, '原卡片超出屏幕');
      check(links.every(n => { const b = n.getBoundingClientRect(); return b.left >= bounds.left && b.right <= bounds.right; }), '融合入口超出卡片');
      links[0].click(); await wait();
      const back = detail.querySelector('.agent-center-floating-face-back');
      check(!back.inert && back.scrollWidth <= back.clientWidth + 1, '配置背面溢出');
      const closeRect = back.querySelector('[data-agent-float-close]').getBoundingClientRect();
      check(closeRect.top >= bounds.top && closeRect.bottom <= bounds.bottom, '配置快捷入口把顶部操作滚出视野');
      const memory = detail.querySelector('[data-hop-fused-config="memory_table"]');
      check(memory?.open && memory.querySelector('[data-memory-agent-save]'), '实际记忆编辑器未展开');
      const variableLink = detail.querySelector('[data-hop-fused-open="variable"]');
      check(variableLink, '当前设置没有变量融合项');
      back.querySelector('[data-agent-float-flip]').click(); variableLink.click();
      detail.querySelector('[data-hop-variable-config]').click(); await wait();
      check(r.panels.variablePanel.hasVisibleLayer(), '变量面板没打开');
      r.actions.closeTopAppLayer(); await wait();
      check(!r.panels.variablePanel.hasVisibleLayer() && detail.open, '实际返回链未先关闭变量面板');
      r.actions.closeTopAppLayer(); await wait();
      check(!detail.open && ac.isVisible(), '第二次返回没有回到 AC');
      check(before === JSON.stringify(r.stores.hopscotchTurnRuntime.resolveBoard(r.stores.chatStore?.getCurrent?.())), '浏览配置改写了有效板');
      root.querySelector('[data-hop-house="body"]').click(); await wait();
      return { width: innerWidth, entries: links.length, cardWidth: bounds.width, fusionWidth: groupRect.width, fusionHeight: groupRect.height, memberTitle: titles[0].fontSize, returnOrder: true };
    })()`);
    assert.equal(result.width, width);
    const front = await command('Page.captureScreenshot', { format: 'png' });
    writeFileSync(`.hopscotch-fused-front-${width}.png`, Buffer.from(front.data, 'base64'));
    await evaluateInApp(`(async () => {
      const detail = document.querySelector('.hop-house-detail[open]');
      detail.querySelector('[data-hop-fused-open="memory_table"]').click();
      await new Promise(resolve => setTimeout(resolve, 350));
    })()`);
    const back = await command('Page.captureScreenshot', { format: 'png' });
    writeFileSync(`.hopscotch-fused-back-${width}.png`, Buffer.from(back.data, 'base64'));
    await evaluateInApp(`window.appBridge.debugUiRegistry.actions.closeTopAppLayer()`);
    await evaluateInApp(`(async () => {
      const root = window.appBridge.debugUiRegistry.panels.agentCenterPanel.contentElement.querySelector('.hop-embedded');
      root.querySelector('.hop-board-toolbar').scrollIntoView({ block: 'start' });
      root.querySelector('.hop-court-scroll').scrollLeft = 0;
      await new Promise(resolve => setTimeout(resolve, 100));
    })()`);
    const boardShot = await command('Page.captureScreenshot', { format: 'png' });
    writeFileSync('.hopscotch-fused-board-' + width + '.png', Buffer.from(boardShot.data, 'base64'));
    const reachable = await evaluateInApp(`(async () => {
      const root = window.appBridge.debugUiRegistry.panels.agentCenterPanel.contentElement.querySelector('.hop-embedded');
      const results = [];
      for (const part of root.querySelectorAll('[data-hop-part]')) {
        part.scrollIntoView({ block: 'center', inline: 'center' });
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const r = part.getBoundingClientRect();
        results.push(part.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)));
      }
      return results;
    })()`);
    assert.ok(reachable.every(Boolean), '窄屏必须可滚动到每个分区并点击');
    console.log('ok - real fused configuration layout and variables → body → AC back order', result);
  }
} finally {
  await command('Emulation.clearDeviceMetricsOverride');
  socket.close();
}
