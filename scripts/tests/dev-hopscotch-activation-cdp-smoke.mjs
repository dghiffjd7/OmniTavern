// Windows dev WebView：隔离内存板与角色变量能力，验证停用保位、共享开关隔离和触屏操作。
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createWsClient, findAppPageTarget, evaluateInApp } from '../dev/cdp-client.mjs';

const target = await findAppPageTarget(), pending = new Map();
let client, seq = 0;
await new Promise((resolve, reject) => {
  client = createWsClient(target.webSocketDebuggerUrl, { onOpen: resolve, onError: reject, onMessage: raw => {
    const msg = JSON.parse(raw), entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    msg.error ? entry.reject(new Error(JSON.stringify(msg.error))) : entry.resolve(msg.result);
  } });
});
const command = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq; pending.set(id, { resolve, reject }); client.send(JSON.stringify({ id, method, params }));
});
const settle = () => new Promise(resolve => setTimeout(resolve, 300));
const capture = async name => {
  if (!process.env.HOP_SCREENSHOT_DIR) return;
  const { data } = await command('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${process.env.HOP_SCREENSHOT_DIR}/activation-${name}.png`, Buffer.from(data, 'base64'));
};
try {
  await command('Emulation.setDeviceMetricsOverride', { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
  await evaluateInApp(`(async () => {
    const registry = window.appBridge.debugUiRegistry;
    if (registry.panels.agentCenterPanel.hide() === false) throw new Error('Existing unsaved AC draft');
    const { AgentCenterPanel } = await import('/scripts/ui/agent-center-panel.js');
    const { createHopscotchBoardPanel } = await import('/scripts/ui/chat/hopscotch-board-panel.js');
    const { createHopscotchBoardStore } = await import('/scripts/storage/hopscotch-board-store.js');
    const { createHopscotchTurnRuntime, createHopscotchExecutors } = await import('/scripts/ui/chat/hopscotch-turn-runtime.js');
    const { resolveVariableWorkflowActivity } = await import('/scripts/ui/chat/variable-workflow-utils.js');
    const storage = new Map(), store = createHopscotchBoardStore({ storage: { getItem: k => storage.get(k), setItem: (k,v) => storage.set(k,v) } });
    await store.setGlobalBoard({ rows: [
      { houses: [{ id: 'prep', kind: 'custom_prompt', label: '灵感', config: { prompt: 'Keep this configuration' } }] },
      { houses: [{ id: 'dependent', kind: 'custom_prompt', label: '衔接', config: { prompt: 'Use {{house:prep}}' } }] },
      { houses: [{ id: 'body', kind: 'body', fused: ['memory_table', 'image_prompt', 'variable'] }] },
    ] });
    const f = { store, registry, activity: resolveVariableWorkflowActivity(), sharedWrites: 0, requests: 0, settingsReturns: 0 };
    const settings = () => ({ memory: { storageMode: 'table', placeEnabled: true }, variables: { activity: f.activity } });
    f.runtime = createHopscotchTurnRuntime({ boardStore: store, getSettings: () => ({ creativeHopscotchEnabled: true }), resolveWritingSettings: settings,
      createExecutors: info => createHopscotchExecutors({ ...info, custom: { backgroundChat: async () => { f.requests++; throw new Error('Disabled house requested a model'); } } }),
    });
    f.ac = new AgentCenterPanel({ getActions: () => ({}), getHopscotchPanel: () => f.board });
    f.board = createHopscotchBoardPanel({ embedded: true, boardStore: store, runtime: f.runtime, getSessionId: () => 'rp:activation-smoke',
      mountAgentCard: (host, options) => f.ac.mountHopscotchAgentCard(host, options),
      openVariableSettings: ({ onClose }) => {
        f.activity = resolveVariableWorkflowActivity({ variables: { 好感度: 50 }, schemas: { 好感度: { type: 'number', ui: { display: 'progress' } } },
          promptSources: ['Update 好感度 with <UpdateVariable> commands after the reply.'] });
        f.settingsReturns++; onClose();
      },
      openVariablePreviewTools: () => f.ac.openFloatingAgentCard('write_preview'),
    });
    f.ac.show(); await f.ac.refresh();
    f.root = () => f.ac.contentElement.querySelector('.hop-embedded');
    f.detail = () => document.querySelector('.hop-house-detail[open]');
    f.click = (selector, host = f.root()) => { const el = host.querySelector(selector); if (!el) throw new Error('Missing ' + selector); el.click(); };
    f.close = () => f.click('.agent-center-floating-face:not([inert]) [data-agent-float-close]', f.detail());
    window.__hopActivationSmoke = f;
  })()`);
  const empty = await evaluateInApp(`(() => { const f = window.__hopActivationSmoke;
    f.click('[data-hop-part="variable"]');
    return { disabled: f.root().querySelector('[data-hop-part="variable"]').dataset.hopEnabled,
      toggleDisabled: f.detail().querySelector('[data-action="toggle-enabled"]').disabled,
      info: f.detail().querySelector('.hop-variable-info').textContent,
      runtime: f.activity.runtimeEnabled, reason: f.activity.reason };
  })()`);
  assert.equal(empty.disabled, 'false'); assert(empty.toggleDisabled && empty.runtime); assert.equal(empty.reason, 'no_variables');
  await settle(); await capture('empty-variable');
  const active = await evaluateInApp(`(() => { const f = window.__hopActivationSmoke;
    f.click('[data-action="variable-settings"]', f.detail());
    return { enabled: f.root().querySelector('[data-hop-part="variable"]').dataset.hopEnabled,
      checked: f.detail().querySelector('[data-action="toggle-enabled"]').getAttribute('aria-checked'),
      returns: f.settingsReturns, info: f.detail().querySelector('.hop-variable-info').textContent };
  })()`);
  assert.equal(active.enabled, 'true'); assert.equal(active.checked, 'true'); assert.equal(active.returns, 1); assert(active.info.includes('App'));
  const paused = await evaluateInApp(`(async () => { const f = window.__hopActivationSmoke;
    f.click('[data-action="toggle-enabled"]', f.detail()); f.close();
    f.click('[data-hop-house="prep"]'); f.click('[data-action="toggle-enabled"]', f.detail()); f.close();
    f.click('[data-action="save"]'); await new Promise(r => setTimeout(r, 100));
    const board = f.store.getGlobalBoard(), houses = board.rows.flatMap(r => r.houses);
    return { houses: houses.map(h => h.id), prep: houses[0], variable: houses[2].fusedEnabled.variable,
      disabled: f.root().querySelectorAll('.is-disabled').length, active: f.activity.enabled,
      body: houses[2].fused, draft: f.root().querySelector('.hop-source').classList.contains('is-dirty') };
  })()`);
  assert.deepEqual(paused.houses, ['prep', 'dependent', 'body']); assert.equal(paused.prep.enabled, false);
  assert.equal(paused.prep.config.prompt, 'Keep this configuration'); assert.equal(paused.variable, false);
  assert(paused.active && !paused.draft); assert.equal(paused.disabled, 3); assert.equal(paused.body.length, 3);
  await settle(); await capture('desktop-board');
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await command('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  await settle(); await capture('mobile-board');
  await evaluateInApp(`window.__hopActivationSmoke.click('[data-hop-part="variable"]')`);
  await settle(); await capture('mobile-variable');
  const point = await evaluateInApp(`(() => { const f = window.__hopActivationSmoke;
    const b = f.detail().querySelector('.agent-center-floating-face:not([inert]) [data-action="toggle-enabled"]');
    const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  await command('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await command('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await settle();
  assert.equal(await evaluateInApp(`window.__hopActivationSmoke.detail().querySelector('[data-action="toggle-enabled"]').getAttribute('aria-checked')`), 'true');
  const results = await evaluateInApp(`(async () => { const f = window.__hopActivationSmoke;
    f.click('[data-action="toggle-enabled"]', f.detail());
    f.click('[data-action="variable-preview-tools"]', f.detail());
    if (f.detail() || f.ac.floatingAgentId !== 'write_preview') throw new Error('Preview tools layer did not open');
    f.ac.closeFloatingAgentCard();
    f.click('[data-action="save"]'); await new Promise(r => setTimeout(r, 100));
    const turn = f.runtime.prepareTurn({ sessionId: 'rp:activation-smoke', rpUiMode: true });
    await turn.waitForBodyStart(); turn.resolveBody({ status: 'succeeded', messageId: 'fixture' }); await turn.turnPromise;
    return { fused: turn.fused, states: turn.getHouseStates().map(s => ({ id: s.id, status: s.status, reason: s.reason })), requests: f.requests };
  })()`);
  assert.equal(results.requests, 0); assert(!results.fused.includes('variable'));
  assert.deepEqual(results.states.map(s => s.status), ['skipped', 'skipped', 'succeeded']);
  console.log('ok - inactive role, return refresh, preserved workflow, touch re-enable, separate preview tools and skipped execution', { empty, paused, results });
} finally {
  await command('Emulation.setTouchEmulationEnabled', { enabled: false });
  await command('Emulation.clearDeviceMetricsOverride');
  await evaluateInApp(`(() => { const f = window.__hopActivationSmoke; if (!f) return;
    f.runtime.clearScope(); f.ac.destroy(); f.board.dispose(); f.registry.panels.agentCenterPanel.show(); delete window.__hopActivationSmoke;
  })()`);
  client.close();
}
