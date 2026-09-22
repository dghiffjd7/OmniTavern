// Run against the Windows dev WebView with --remote-debugging-port=9222.
// Neutral render fixture only; no chat writes or preset scripts are executed.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { evaluateInApp, findAppPageTarget, createWsClient } from '../dev/cdp-client.mjs';

let cdp, sequence = 0; const pending = new Map();
const command = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence; pending.set(id, { resolve, reject });
  cdp.send(JSON.stringify({ id, method, params }));
});
try {
  await evaluateInApp(String.raw`(async () => {
    const deadline = Date.now() + 25000;
    while (!window.__chatappBootDiag?.runtimeReady && Date.now() < deadline) await new Promise(r => setTimeout(r, 200));
    if (!window.__chatappBootDiag?.runtimeReady) throw new Error('Boot not ready');
    const { renderRichText, cleanupRichText } = await import('/scripts/ui/chat/rich-text-renderer.js');
    const host = document.createElement('section');
    host.style.cssText = 'position:fixed;inset:0;z-index:99999;padding:24px;overflow:auto;background:var(--app-surface-card);color:var(--app-text-primary)';
    const content = document.createElement('div'); content.className = 'QQ_chat_msgdiv chat-message-content';
    content.style.cssText = 'max-width:760px;margin:auto;line-height:1.7'; host.append(content); document.body.append(host);
    window.__joinedFenceSmoke = { host, content, cleanupRichText };
    const fence = String.fromCharCode(96).repeat(3);
    const card = fence + '\n<!doctype html><html><body><details><summary>折叠卡片</summary>卡片内容</details></body></html>\n' + fence;
    const paragraphs = ['第一段：原始回复中的空行应保留。', '第二段：正文可以独立选择，段落之间有清楚的间距。', '第三段：正文后仍可展开摘要。'];
    const prose = '<game>\n' + paragraphs.join('\n\n') + '\n</game>\n<details><summary>摘要</summary>摘要内容</details>\n';
    renderRichText(content, card + prose + card, { messageId: 'joined-fence-smoke', preserveHtmlNewlines: true, deferSandboxExecution: true });
  })()`);
  const page = await findAppPageTarget();
  await new Promise((resolve, reject) => { cdp = createWsClient(page.webSocketDebuggerUrl, {
    onOpen: resolve, onError: reject, onMessage: raw => {
      const item = JSON.parse(raw), waiter = pending.get(item.id); if (!waiter) return;
      pending.delete(item.id); item.error ? waiter.reject(new Error(item.error.message)) : waiter.resolve(item.result);
    },
  }); });
  for (const width of [1100, 390]) {
    await command('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
    const result = await evaluateInApp(`(() => {
      const { host, content } = window.__joinedFenceSmoke;
      const paragraphs = [...content.querySelectorAll('p')].filter(node => !node.closest('details'));
      const details = content.querySelector('details'); details.querySelector('summary').click();
      const range = document.createRange(); range.selectNodeContents(paragraphs[1]);
      const rects = paragraphs.map(node => node.getBoundingClientRect());
      const result = { count: paragraphs.length, separated: rects.every((r,i) => !i || r.top > rects[i-1].bottom),
        selectable: range.toString().startsWith('第二段'), expanded: details.open,
        cards: content.querySelectorAll('[data-rich-render-deferred]').length, overflow: host.scrollWidth > host.clientWidth };
      details.open = false; return result;
    })()`);
    assert.equal(result.count, 3); assert(result.separated); assert(result.selectable); assert(result.expanded);
    assert.equal(result.cards, 2); assert(!result.overflow);
    const shot = await command('Page.captureScreenshot', { format: 'png' });
    writeFileSync(`scripts/dev/tmp/joined-fence-${width}.png`, Buffer.from(shot.data, 'base64'));
  }
  console.log(JSON.stringify({ passed:true, views:[1100,390], paragraphs:3, cards:2, chatWrites:0 }));
} finally {
  if (cdp) { await command('Emulation.clearDeviceMetricsOverride').catch(() => {}); cdp.close(); }
  await evaluateInApp(`(() => { const s = window.__joinedFenceSmoke; if (s) { s.cleanupRichText(s.content); s.host.remove(); delete window.__joinedFenceSmoke; } })()`).catch(() => {});
}
