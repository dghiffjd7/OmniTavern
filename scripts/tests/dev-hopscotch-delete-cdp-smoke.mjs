// Windows WebView：实际 AC 浮卡，隔离板/配置/假执行器；不修改真实数据。
import assert from 'node:assert/strict';
import { evaluateInApp, createWsClient, findAppPageTarget } from '../dev/cdp-client.mjs';

// 可选参数 390 / 320：同一用例验证窄屏实际点击区域；结束恢复尺寸。
const width = Number(process.argv[2]) || 0;
let socket, command;
if (width) {
  const page = await findAppPageTarget(), pending = new Map();
  let sequence = 0;
  await new Promise((resolve, reject) => {
    socket = createWsClient(page.webSocketDebuggerUrl, { onOpen: resolve, onError: reject, onMessage: raw => {
      const message = JSON.parse(raw), item = pending.get(message.id);
      if (!item) return;
      pending.delete(message.id);
      if (message.error) item.reject(new Error(JSON.stringify(message.error))); else item.resolve(message.result);
    } });
  });
  command = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
  });
}

try {
if (width) await command('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: false });
const result = await evaluateInApp(`(async () => {
  const check = (v, message) => { if (!v) throw new Error(message); };
  const tick = () => new Promise(resolve => setTimeout(resolve, 350));
  const registry = window.appBridge.debugUiRegistry;
  window.__hopscotchSmokePanel?.dispose();
  check(registry.panels.agentCenterPanel.hide() !== false, '真实 AC 有未保存草稿，停止烟测');
  const { AgentCenterPanel } = await import('/scripts/ui/agent-center-panel.js');
  const { createHopscotchBoardPanel } = await import('/scripts/ui/chat/hopscotch-board-panel.js');
  const { createHopscotchBoardStore } = await import('/scripts/storage/hopscotch-board-store.js');
  const { createHopscotchTurnRuntime, createHopscotchExecutors } = await import('/scripts/ui/chat/hopscotch-turn-runtime.js');
  const local = new Map(), sessions = new Map();
  let writes = 0, enabled = true, place = 'writing', board, requests = 0;
  const store = createHopscotchBoardStore({ storage: { getItem: k => local.get(k), setItem: (k, v) => local.set(k, v) }, getSessionSettings: sid => sessions.get(sid), setSessionSettings: (sid, value) => { writes++; sessions.set(sid, value); return true; } });
  const fixture = { rows: [
    { houses: [{ id: 'source', kind: 'custom_prompt', label: 'Source' }] },
    { houses: [{ id: 'body', kind: 'body', fused: ['image_prompt'] }] },
    { houses: [{ id: 'memory', kind: 'memory_table' }, { id: 'image', kind: 'image_generation' }, { id: 'dependent', kind: 'custom_prompt', label: 'Dependent', config: { prompt: '{{house:source}}' } }] },
    { houses: [{ id: 'legacy', kind: 'summary_compaction' }] },
  ] };
  check((await store.setGlobalBoard(fixture)).ok, 'invalid fixture');
  const baseline = JSON.stringify(store.getGlobalBoard());
  const runtime = createHopscotchTurnRuntime({ boardStore: store, getSettings: () => ({ creativeHopscotchEnabled: enabled }), resolveWritingSettings: () => ({ memory: { storageMode: 'table', autoExtract: true, autoExtractMode: 'separate' } }), createExecutors: info => createHopscotchExecutors({ ...info, custom: { backgroundChat: async () => { requests++; return 'test'; } } }) });
  const ac = new AgentCenterPanel({ getHopscotchPanel: () => board, getActions: () => ({ getMemoryAgentPromptConfig: () => ({ templateId: 'test', template: '{{tableData}}', wrapper: '{{tableData}}', position: 'before_latest_user' }) }) });
  board = createHopscotchBoardPanel({ embedded: true, boardStore: store, runtime, getSessionId: () => 'rp:delete-smoke', getPlace: () => place, enable: v => { enabled = v; }, mountAgentCard: (host, options) => ac.mountHopscotchAgentCard(host, options), confirm: async () => true });
  try {
    ac.show(); await ac.refresh();
    const root = ac.contentElement.querySelector('.hop-embedded');
    const ids = () => [...root.querySelectorAll('[data-hop-house]')].map(n => n.dataset.hopHouse);
    const click = (selector, host = root) => { const n = host.querySelector(selector); check(n, 'missing ' + selector); n.click(); return n; };
    const open = async id => { click('[data-hop-house="' + id + '"]'); await tick(); return document.querySelector('.hop-house-detail[open]'); };
    const close = async () => { board.closeTopLayer(); await tick(); };
    const frontRemove = detail => {
      const button = detail.querySelector('.agent-center-floating-face-front .agent-center-floating-toolbar [data-action="remove"]');
      check(button && !button.matches(':disabled') && !button.closest('[inert]'), '正面顶部缺少可用删除按钮');
      const rect = button.getBoundingClientRect(), card = detail.querySelector('.agent-center-floating-card').getBoundingClientRect();
      check(rect.left >= card.left && rect.right <= card.right && rect.top >= card.top && rect.bottom <= card.bottom, '删除按钮超出卡片');
      check(button.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)), '删除按钮被遮挡');
      return button;
    };
    let detail = await open('body');
    check(!detail.querySelector('[data-action="remove"]'), '正文必需节点不可删除'); await close();
    detail = await open('source'); frontRemove(detail).click(); await tick();
    check(ids().includes('source') && detail.open && detail.querySelector('.agent-center-floating-card.is-flipped'), '引用失败应保留节点并显示背面错误');
    check(detail.querySelector('.hop-error').textContent, '删除依赖失败没有提示'); await close();
    detail = await open('memory');
    click('.agent-center-floating-face-front [data-agent-float-flip]', detail);
    detail.querySelector('[data-memory-prompt-template]').value = 'unsaved memory';
    click('.agent-center-floating-face-back [data-agent-float-flip]', detail); await tick();
    frontRemove(detail).click(); await tick();
    check(detail.open && detail.querySelector('[data-memory-prompt-template]').value === 'unsaved memory' && ids().includes('memory'), '删除不能丢弃共享编辑器草稿');
    check(detail.querySelector('.agent-center-floating-card.is-flipped') && detail.querySelector('.hop-error').textContent, '共享草稿保护提示不可见'); await close();
    const removed = [];
    for (const id of ['dependent', 'source', 'memory', 'image', 'legacy']) {
      detail = await open(id); await ac.refresh(); await tick();
      frontRemove(detail).click();
      check(!detail.open && !ids().includes(id) && root.querySelector('.hop-source.is-dirty'), '正面删除未更新草稿 ' + id);
      removed.push(id);
    }
    check(root.querySelectorAll('[data-hop-row]').length === 1, '空行未清除');
    check(writes === 0 && JSON.stringify(store.getGlobalBoard()) === baseline, '删除草稿提前写入了设置');
    click('[data-action="save"]'); await tick();
    check(writes === 1 && store.getSessionOverride('rp:delete-smoke').rows.length === 1, '保存没有应用删除');
    check(JSON.stringify(store.getGlobalBoard()) === baseline, '会话删除误改全局板');
    await store.setSessionOverride('rp:delete-smoke', fixture); board.close(); ac.show(); await ac.refresh();
    detail = await open('memory');
    const turn = runtime.prepareTurn({ sessionId: 'rp:delete-smoke', rpUiMode: true }); await turn.waitForBodyStart();
    check([...detail.querySelectorAll('[data-action="remove"]')].every(n => n.matches(':disabled')), '开始运行后未锁定已打开的删除按钮');
    turn.resolveBody({ status: 'succeeded', messageId: 'fake' }); await turn.turnPromise;
    click('.agent-center-floating-face-front [data-action="remove"]', detail);
    check(detail.open && ids().includes('memory'), '运行期间锁定的浮卡不应在结束后误删'); await close();
    click('[data-action="run-mode"]'); detail = await open('memory');
    check(!detail.querySelector('[data-action="remove"]'), '运行记录不能删除'); await close();
    place = 'chat'; board.close(); ac.show(); await ac.refresh(); detail = await open('memory');
    check(!detail.querySelector('[data-action="remove"]'), '聊天投影不能删除编排节点'); await close();
    return { removed, dependencyGuard: true, sharedDraftGuard: true, sessionOnlySave: true, runtimeReadOnly: true, width: innerWidth, requests };
  } finally { runtime.clearScope(); ac.destroy(); board.dispose(); registry.panels.agentCenterPanel.show(); }
})()`);
assert.equal(result.removed.length, 5);
console.log('ok - house deletion from original floating toolbar, draft-only persistence and safety guards', result);
} finally {
  if (socket) { await command('Emulation.clearDeviceMetricsOverride'); socket.close(); }
}
