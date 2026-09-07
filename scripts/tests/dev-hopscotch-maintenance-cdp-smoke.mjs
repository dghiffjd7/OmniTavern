// Windows dev WebView：原 AC 卡片 + 隔离板/假维护，不写真实设置、不请求模型。
import assert from 'node:assert/strict';
import { evaluateInApp } from '../dev/cdp-client.mjs';

const results = await evaluateInApp(`(async () => {
  const check = (value, message) => { if (!value) throw new Error(message); };
  const tick = () => new Promise(resolve => setTimeout(resolve, 30));
  window.__hopscotchSmokePanel?.dispose();
  window.__agentCenterHopscotchSmoke?.dispose();
  window.__agentCenterMigrationSmoke?.dispose();
  const realAC = window.appBridge.debugUiRegistry.panels.agentCenterPanel;
  check(realAC.hide() !== false, '真实 AC 有草稿，停止烟测');
  const { AgentCenterPanel } = await import('/scripts/ui/agent-center-panel.js');
  const { createHopscotchBoardPanel } = await import('/scripts/ui/chat/hopscotch-board-panel.js');
  const { createHopscotchBoardStore } = await import('/scripts/storage/hopscotch-board-store.js');
  const { createHopscotchTurnRuntime, createHopscotchExecutors } = await import('/scripts/ui/chat/hopscotch-turn-runtime.js');
  const answers = [];
  try {
    for (const [mode, outcome] of [['inline', 'skipped'], ['separate', 'failed'], ['inline', 'cancelled']]) {
      const local = new Map();
      const store = createHopscotchBoardStore({ storage: { getItem: k => local.get(k), setItem: (k, v) => local.set(k, v) } });
      let finish, requests = 0, requestSignal, board;
      const runtime = createHopscotchTurnRuntime({
        boardStore: store, getSettings: () => ({ creativeHopscotchEnabled: true }),
        resolveWritingSettings: () => ({ memory: { storageMode: 'table', autoExtract: true, autoExtractMode: mode } }),
        createExecutors: info => createHopscotchExecutors({ ...info,
          memory: { runMemoryUpdateAfterChat: async () => ({ status: 'succeeded' }) },
          compaction: { place: 'writing', request: (_, options) => { requests++; requestSignal = options.signal; return new Promise(resolve => { finish = resolve; }); } },
        }),
      });
      await store.setGlobalBoard(runtime.resolveBoard('rp:maintenance-smoke').board);
      const ac = new AgentCenterPanel({ getActions: () => ({}), getHopscotchPanel: () => board });
      board = createHopscotchBoardPanel({ embedded: true, boardStore: store, runtime, getSessionId: () => 'rp:maintenance-smoke', mountAgentCard: (host, options) => ac.mountHopscotchAgentCard(host, options) });
      let turn;
      try {
        ac.show(); await ac.refresh();
        const root = ac.contentElement.querySelector('.hop-embedded');
        const click = (selector, host = root) => { const node = host.querySelector(selector); check(node, 'missing ' + selector); node.click(); };
        const close = () => click('.agent-center-floating-face:not([inert]) [data-agent-float-close]', document.querySelector('.hop-house-detail[open]'));
        turn = runtime.prepareTurn({ sessionId: 'rp:maintenance-smoke', rpUiMode: true });
        await turn.waitForBodyStart();
        turn.setBodyContext({ buildMemoryContext: () => ({}) });
        turn.resolveBody({ status: 'succeeded', messageId: 'delivered' });
        await tick();
        check(requests === 1, '保存默认板丢失或重复维护');
        click('[data-action="run-mode"]');
        const hostId = mode === 'inline' ? 'body' : 'memory';
        const cellSelector = '[data-hop-house="' + hostId + '"]';
        check(root.querySelectorAll('[data-hop-house]').length === (mode === 'inline' ? 1 : 2), '维护不应增加可见房子');
        check(root.querySelector(cellSelector).classList.contains('is-running'), '维护尚未结束时格子不能提前完成');
        click(cellSelector);
        let detail = document.querySelector('.hop-house-detail[open]');
        check(detail.querySelector('.hop-card-status').textContent.includes('执行中'), '原浮卡没有维护中状态');
        click('.agent-center-floating-face-front [data-agent-float-flip]', detail);
        check(!detail.querySelector('.agent-center-floating-face-back').inert, '原卡片翻面失效');
        check(detail.querySelector('fieldset').disabled, '运行快照背面不能编辑');
        close();
        if (outcome === 'cancelled') turn.abort();
        else finish(outcome === 'skipped' ? false : { status: 'failed', reason: 'smoke_failure' });
        const result = await turn.turnPromise; await tick();
        const expected = outcome === 'failed' ? 'partial' : outcome === 'cancelled' ? 'cancelled' : 'succeeded';
        check(result.status === expected && result.bodyDelivered, '终态/正文交付错误');
        check(root.querySelector(cellSelector).classList.contains('is-' + expected), '格子未反映内部维护终态');
        click(cellSelector); detail = document.querySelector('.hop-house-detail[open]');
        check(detail.textContent.includes('summary_compaction') && detail.textContent.includes(outcome), '原卡片详情丢失维护结果');
        close();
        if (outcome === 'cancelled') { check(requestSignal.aborted, '没有透传取消'); finish(true); }
        answers.push({ mode, status: result.status, bodyDelivered: result.bodyDelivered, requests });
      } finally {
        runtime.clearScope();
        if (turn) await turn.turnPromise;
        ac.destroy(); board.dispose();
      }
    }
  } finally { realAC.show(); }
  return answers;
})()`);
assert.equal(results.length, 3);
assert.ok(results.every(result => result.bodyDelivered && result.requests === 1));
console.log('ok - original AC cards track saved-default maintenance, flip, partial failure and cancellation', results);
