// Windows WebView：融合配置复用原 AC；写入只进隔离对象，预览不发模型请求。
import assert from 'node:assert/strict';
import { evaluateInApp } from '../dev/cdp-client.mjs';

const result = await evaluateInApp(`(async () => {
  const check = (value, message) => { if (!value) throw new Error(message); };
  const tick = () => new Promise(resolve => setTimeout(resolve, 50));
  for (let i = 0; i < 100 && !window.appBridge?.debugUiRegistry?.stores?.hopscotchBoardPanel; i++) await tick();
  const registry = window.appBridge.debugUiRegistry;
  window.__hopscotchSmokePanel?.dispose(); window.__agentCenterMigrationSmoke?.dispose(); window.__agentCenterHopscotchSmoke?.dispose();
  check(registry.panels.agentCenterPanel.hide() !== false, '真实 AC 有草稿，停止烟测');
  const { AgentCenterPanel } = await import('/scripts/ui/agent-center-panel.js');
  const { createHopscotchBoardPanel } = await import('/scripts/ui/chat/hopscotch-board-panel.js');
  const { createHopscotchBoardStore } = await import('/scripts/storage/hopscotch-board-store.js');
  const { createHopscotchTurnRuntime, createHopscotchExecutors } = await import('/scripts/ui/chat/hopscotch-turn-runtime.js');
  const local = new Map();
  const store = createHopscotchBoardStore({ storage: { getItem: k => local.get(k), setItem: (k, v) => local.set(k, v) } });
  await store.setGlobalBoard({ rows: [{ houses: [{ id: 'body', kind: 'body', fused: ['memory_table', 'image_prompt', 'variable'] }] }] });
  let prompt = { enabled: true, rules: 'saved image rules' };
  let memoryPrompt = { templateId: 't1', template: '{{tableData}}', wrapper: '<memories>{{tableData}}</memories>', position: 'before_latest_user' };
  let board, variables = 0, writes = 0, allowDiscard = false, requests = 0;
  const previews = [];
  const runtime = createHopscotchTurnRuntime({ boardStore: store, getSettings: () => ({ creativeHopscotchEnabled: true }), createExecutors: info => createHopscotchExecutors({ ...info, custom: { backgroundChat: async () => { requests++; return 'unexpected'; } } }) });
  const actions = {
    getMemoryAgentPromptConfig: () => memoryPrompt,
    getAgentCenterProfileView: () => ({ sysprompt: { presetId: 'p1', profile: { agents: { image_director: { prompts: { 'auto-image-prompt': prompt } } } } }, openai: { presetId: 'o1', profile: { agents: { memory_table_agent: { settings: {} } } } } }),
    setAgentPromptConfig: payload => { check(payload.agentId === 'image_director' && payload.promptId === 'auto-image-prompt', 'wrong image config target'); writes++; prompt = payload.config; return true; },
    setMemoryAgentSettings: () => { writes++; return true; },
    setMemoryAgentPromptConfig: payload => { writes++; memoryPrompt = { ...memoryPrompt, ...payload.config }; return true; },
    showPromptPreview: payload => {
      previews.push(payload.agentId);
      registry.actions.showPromptPreviewModal('isolated fused preview', 'test only', { request: { messages: [{ role: 'user', content: 'test' }], model: 'test', options: {} } });
      return true;
    },
  };
  const ac = new AgentCenterPanel({ getActions: () => actions, getHopscotchPanel: () => board, confirm: async () => allowDiscard, notifyError: () => {}, notifySuccess: () => {} });
  const variablePanel = registry.panels.variablePanel;
  board = createHopscotchBoardPanel({ embedded: true, boardStore: store, runtime, getSessionId: () => 'rp:fused-smoke', confirm: async () => allowDiscard,
    mountAgentCard: (host, options) => ac.mountHopscotchAgentCard(host, options),
    openVariables: ({ sessionId }) => { check(sessionId === 'rp:fused-smoke', 'lost session'); variables++; variablePanel.show(); return true; },
    closeRelatedLayer: () => variablePanel.hasVisibleLayer() && variablePanel.closeTopLayer(),
  });
  try {
    ac.show(); await ac.refresh();
    const root = ac.contentElement.querySelector('.hop-embedded');
    const click = (selector, host = root) => { const n = host.querySelector(selector); check(n, 'missing ' + selector); n.click(); };
    check(root.querySelectorAll('[data-hop-house]').length === 1 && root.querySelectorAll('[data-hop-part]').length === 4, '融合成员应分区显示，但仍只算一个房子');
    click('[data-hop-part="memory_table"]');
    let detail = document.querySelector('.hop-house-detail[open]');
    check(detail.querySelector('.agent-center-floating-card.is-flipped') && detail.querySelector('[data-hop-fused-config="memory_table"]').open, '板内分区应直接进入对应原配置');
    check(detail.querySelectorAll('[data-hop-fused-open]').length === 3, '正文卡片缺少融合项配置入口');
    click('[data-hop-fused-open="memory_table"]', detail);
    check(detail.querySelector('.agent-center-floating-card.is-flipped'), 'shortcut must flip the original card');
    check(detail.querySelector('[data-hop-fused-config="memory_table"]').open, 'memory configuration did not expand');
    let memoryInput = detail.querySelector('[data-memory-prompt-template]');
    check(memoryInput, 'missing original memory editor');
    memoryInput.value = 'memory draft {{tableData}}';
    click('.agent-center-floating-face-back [data-agent-float-flip]', detail);
    click('[data-hop-fused-open="image_prompt"]', detail);
    let imageInput = detail.querySelector('[data-agent-prompt-rules]');
    check(imageInput?.value === 'saved image rules', 'wrong shared image editor');
    imageInput.value = 'image draft'; imageInput.focus();
    await ac.refresh();
    imageInput = detail.querySelector('[data-agent-prompt-rules]');
    check(imageInput.value === 'image draft' && document.activeElement === imageInput, 'refresh lost image draft/focus');
    check(detail.querySelector('[data-memory-prompt-template]').value === 'memory draft {{tableData}}', 'switch lost memory draft');
    check(!detail.querySelector('[data-hop-fused-config="memory_table"]').open && detail.querySelector('[data-hop-fused-config="image_prompt"]').open, 'refresh lost selected configuration');
    check(detail.querySelectorAll('[data-agent-prompt-preview]').length === 1, 'fused view must preview the body, not independent requests');
    click('[data-agent-prompt-preview="body"]', detail); await tick();
    document.querySelector('#prompt-preview-close').click();
    check(imageInput.value === 'image draft' && detail.open, 'preview lost draft/card');
    click('[data-agent-prompt-save]', detail); await tick();
    check(prompt.rules === 'image draft', 'save did not reach existing image preset');
    click('.agent-center-floating-face-back [data-agent-float-flip]', detail);
    click('[data-hop-fused-open="variable"]', detail);
    click('[data-hop-variable-config]', detail); await tick();
    await Promise.all(variablePanel.overlay.getAnimations({ subtree: true }).filter(a => a.effect.getComputedTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})));
    const rect = variablePanel.panel.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + 25);
    check(variablePanel.overlay.contains(hit), 'variables are obscured: ' + JSON.stringify({ hit: hit?.className, z: getComputedStyle(variablePanel.overlay).zIndex, acZ: getComputedStyle(ac.overlayElement).zIndex, open: variablePanel.overlay.className, top: rect.top }));
    check(board.closeTopLayer(), 'back did not close related variables layer'); await new Promise(resolve => setTimeout(resolve, 230));
    check(!variablePanel.hasVisibleLayer() && detail.open, 'back closed body before variables');
    check(detail.querySelector('[data-memory-prompt-template]').value === 'memory draft {{tableData}}', 'variables round trip lost shared draft');
    click('.agent-center-floating-face-back [data-agent-float-close]', detail); await tick();
    check(detail.open, 'dirty shared draft closed without permission');
    allowDiscard = true; click('.agent-center-floating-face-back [data-agent-float-close]', detail); await tick();
    const turn = runtime.prepareTurn({ sessionId: 'rp:fused-smoke', rpUiMode: true });
    await turn.waitForBodyStart(); turn.resolveBody({ status: 'succeeded', messageId: 'test' }); await turn.turnPromise;
    click('[data-action="run-mode"]'); click('[data-hop-house="body"]'); detail = document.querySelector('.hop-house-detail[open]');
    click('[data-hop-fused-open="variable"]', detail);
    check(detail.querySelector('[data-hop-variable-config]').matches(':disabled'), 'run snapshot can open mutable variable settings');
    check(detail.querySelector('[data-agent-prompt-rules]').matches(':disabled'), 'run snapshot can edit shared prompt');
    check(previews.join(',') === 'body' && variables === 1 && writes === 1 && requests === 0, 'unexpected calls');
    return { fusedEntries: 3, originalEditors: true, draftsPreserved: true, bodyPreview: previews, variableReturn: true, writes, requests };
  } finally {
    variablePanel.hide(); runtime.clearScope(); ac.destroy(); board.dispose(); registry.panels.agentCenterPanel.show();
  }
})()`);
assert.equal(result.fusedEntries, 3);
assert.equal(result.requests, 0);
console.log('ok - fused configuration links reuse original editors and preserve drafts across preview/variables', result);
