// 真实 WebView / 隔离内存配置。所有共享设置写入都截获到本脚本，不调用模型。
import assert from 'node:assert/strict';
import { evaluateInApp } from '../dev/cdp-client.mjs';

const result = await evaluateInApp(`(async () => {
  const check = (value, message) => { if (!value) throw new Error(message); };
  const tick = () => new Promise(resolve => setTimeout(resolve, 40));
  const click = (root, selector) => { const node = root.querySelector(selector); check(node, 'missing ' + selector); node.click(); };
  for (let i = 0; i < 100 && !window.appBridge?.debugUiRegistry?.stores?.hopscotchBoardPanel; i++) await new Promise(resolve => setTimeout(resolve, 100));
  window.__hopscotchSmokePanel?.dispose();
  window.__agentCenterHopscotchSmoke?.dispose();
  window.__agentCenterMigrationSmoke?.dispose();
  check(window.appBridge.debugUiRegistry.panels.agentCenterPanel.hide() !== false, '真实 AC 有未保存草稿，停止烟测');
  const { AgentCenterPanel } = await import('/scripts/ui/agent-center-panel.js');
  const { createHopscotchBoardPanel } = await import('/scripts/ui/chat/hopscotch-board-panel.js');
  const { createHopscotchBoardStore } = await import('/scripts/storage/hopscotch-board-store.js');
  const { createHopscotchTurnRuntime } = await import('/scripts/ui/chat/hopscotch-turn-runtime.js');
  const { closeCustomSelectMenu } = await import('/scripts/ui/custom-select.js');
  const local = new Map();
  const store = createHopscotchBoardStore({ storage: { getItem: k => local.get(k), setItem: (k, v) => local.set(k, v) } });
  await store.setGlobalBoard({ rows: [{ id: 'a', houses: [{ id: 'body', kind: 'body', fused: ['image_prompt'] }] }, { id: 'b', houses: [{ id: 'image', kind: 'image_generation' }, { id: 'review', kind: 'format_review' }, { id: 'memory', kind: 'memory_table' }] }] });
  const requests = [];
  const writes = [];
  const previews = [];
  const feature = { enabled: true, modelMode: 'none' };
  let presetId = 'p1';
  let prompt = { enabled: true, rules: 'saved prompt' };
  let memoryPrompt = { templateId: 't1', template: '{{tableData}}', wrapper: '<memories>{{tableData}}</memories>', position: 'before_latest_user' };
  let memorySettings = {};
  let failSave = false;
  let allowDiscard = false;
  let confirmations = 0;
  const runtime = createHopscotchTurnRuntime({ boardStore: store, getSettings: () => ({}), createExecutors: () => { requests.push('unexpected'); return {}; } });
  const actions = {
    showPromptPreview: payload => {
      previews.push(payload);
      window.appBridge.debugUiRegistry.actions.showPromptPreviewModal('isolated preview', 'AC migration smoke', {
        request: { messages: [{ role: 'system', content: 'isolated preview ' + payload.agentId }, { role: 'user', content: 'test only' }], model: 'test-model', options: {}, session: { id: 'rp:preview-smoke', name: '隔离预览' } }, initialTab: 'prompt',
      });
      return true;
    },
    getAgentFeatureSettings: () => ({ features: { reply_check: feature } }),
    listAgentModelProfiles: () => [{ id: 'profile-a', name: '测试模型', model: 'test-model' }],
    getMemoryAgentPromptConfig: () => memoryPrompt,
    getAgentCenterProfileView: () => ({ sysprompt: { presetId, profile: { agents: { image_director: { prompts: { 'auto-image-prompt': prompt } } } } }, openai: { presetId: 'o1', profile: { agents: { memory_table_agent: { settings: memorySettings } } } } }),
    setAgentPromptConfig: payload => { writes.push(payload); if (failSave) return false; prompt = payload.config; return true; },
    setAgentFeatureModel: payload => { writes.push(payload); Object.assign(feature, payload); return true; },
    setMemoryAgentSettings: payload => { writes.push(payload); memorySettings = payload.config; return true; },
    setMemoryAgentPromptConfig: payload => { writes.push(payload); memoryPrompt = { ...memoryPrompt, ...payload.config }; return true; },
  };
  let board;
  const confirm = async () => { confirmations++; return allowDiscard; };
  const ac = new AgentCenterPanel({ getActions: () => actions, getHopscotchPanel: () => board, confirm, notifyError: () => {}, notifySuccess: () => {} });
  board = createHopscotchBoardPanel({ embedded: true, boardStore: store, runtime, confirm, mountAgentCard: (host, options) => ac.mountHopscotchAgentCard(host, options) });
  const dispose = () => { closeCustomSelectMenu(); ac.destroy(); board.dispose(); };
  window.__agentCenterMigrationSmoke = { ac, board, dispose };
  ac.show(); await ac.refresh();
  const root = ac.contentElement.querySelector('.hop-embedded');
  const closePreview = () => {
    const overlay = document.getElementById('prompt-preview-overlay');
    const button = overlay?.querySelector('#prompt-preview-close');
    check(overlay && getComputedStyle(overlay).display !== 'none', 'original prompt preview UI did not open');
    const r = button.getBoundingClientRect();
    check(overlay.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)), 'preview is obscured by house card');
    button.click();
    check(document.querySelector('.hop-house-detail[open]'), 'closing preview also closed house card');
  };
  check(!ac.contentElement.querySelector('.agent-center-agent-list'), 'old card wall remains');
  check(ac.contentElement.querySelectorAll('.hop-agent-tile').length === ac.getAgentCards().length, 'catalog lost an Agent');
  const openShared = async id => {
    click(root, '[data-hop-house="' + id + '"]');
    const detail = document.querySelector('.hop-house-detail[open]');
    check(detail.querySelector('.agent-center-agent-badge') && detail.querySelector('.agent-center-chip-row'), 'house did not reuse original Agent front');
    click(detail, '.agent-center-floating-face-front [data-agent-float-flip]');
    await tick();
    check(detail.querySelector('.agent-center-floating-card.is-flipped'), 'original Agent flip not connected');
    check(!detail.querySelector('.hop-shared-settings'), 'configuration / preview hidden under another disclosure');
    check(!ac.floatingAgentId, 'shared editor opened a second Agent card');
    return detail;
  };
  let detail = await openShared('image');
  click(detail, '[data-agent-prompt-preview]');
  await tick();
  check(previews.at(-1)?.agentId === 'image_director', 'image prompt preview entry not connected');
  closePreview();
  let input = detail.querySelector('[data-agent-prompt-rules]');
  check(input?.value === 'saved prompt', 'shared editor did not read existing preset');
  input.value = 'shared draft';
  input.focus();
  click(detail, '[data-agent-prompt-preview]'); await tick(); closePreview();
  check(input.value === 'shared draft', 'preview round trip discarded the editor draft');
  input.focus();
  await ac.refresh();
  input = detail.querySelector('[data-agent-prompt-rules]');
  check(input.value === 'shared draft' && document.activeElement === input, 'shared draft / focus lost on AC refresh');
  click(detail, '[data-agent-prompt-save]');
  await tick(); await ac.refresh();
  check(prompt.rules === 'shared draft' && writes[0].presetId === 'p1' && writes[0].agentId === 'image_director', 'wrong shared prompt save target');
  check(!ac.sharedAgentConfig || !board.isOpen() || detail.open, 'card unexpectedly closed');
  failSave = true;
  detail.querySelector('[data-agent-prompt-rules]').value = 'failed save draft';
  click(detail, '[data-agent-prompt-save]');
  await tick();
  check(detail.querySelector('.hop-error').textContent, 'failed save invisible');
  await ac.refresh();
  check(detail.querySelector('[data-agent-prompt-rules]').value === 'failed save draft', 'failed save lost user text');
  board.closeTopLayer(); await tick();
  check(detail.open && confirmations === 1, 'discard cancel closed edited card');
  presetId = 'p2';
  await ac.refresh();
  check(detail.querySelector('[data-agent-prompt-rules]').value === 'shared draft', 'old draft leaked into another preset');
  click(detail, '.agent-center-floating-face-back [data-agent-float-close]');
  failSave = false;
  detail = await openShared('review');
  click(detail, '[data-agent-prompt-preview]'); await tick();
  check(previews.at(-1)?.agentId === 'reply_check', 'review prompt preview lost its Agent identity');
  closePreview();
  click(detail, '[data-agent-feature-model-button]');
  detail.querySelector('[data-agent-feature-model-button]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await tick();
  check(detail.open && getComputedStyle(document.querySelector('.world-app-select-menu')).display === 'none', 'Escape must close model menu before house card');
  click(detail, '[data-agent-feature-model-button]');
  const menu = document.querySelector('.world-app-select-menu');
  check(menu && getComputedStyle(menu).display !== 'none', 'model menu not open');
  const option = menu.querySelector('[data-value="profile:profile-a"]');
  const r = option.getBoundingClientRect();
  check(menu.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)), 'model menu blocked by house dialog');
  option.click(); await tick(); await ac.refresh();
  check(feature.modelProfileId === 'profile-a' && detail.querySelector('[data-agent-feature-model-override]'), 'shared model binding did not refresh');
  click(detail, '.agent-center-floating-face-back [data-agent-float-close]');
  detail = await openShared('memory');
  detail.querySelector('[data-memory-prompt-template]').value = 'memory draft {{tableData}}';
  await ac.refresh();
  check(detail.querySelector('[data-memory-prompt-template]').value.includes('memory draft'), 'memory draft lost');
  click(detail, '[data-memory-agent-save]'); await tick(); await ac.refresh();
  check(memoryPrompt.template.includes('memory draft') && writes.at(-1).templateId === 't1', 'memory editor did not reuse existing writes');
  click(detail, '[data-agent-prompt-preview]'); await tick();
  check(previews.at(-1)?.agentId === 'memory_table_agent', 'memory prompt preview entry missing');
  closePreview();
  click(detail, '.agent-center-floating-face-back [data-agent-float-close]');
  detail = await openShared('body');
  click(detail, '[data-agent-prompt-preview]'); await tick();
  check(previews.at(-1)?.agentId === 'body', 'body cannot reach existing draft prompt preview');
  closePreview();
  click(detail, '.agent-center-floating-face-back [data-agent-float-close]');
  click(root, '[data-hop-add="0"][data-hop-new="1"]');
  click(document.querySelector('.hop-detail[open]'), '[data-action="add:custom_prompt"]');
  detail = await openShared(root.querySelector('[data-hop-house]').dataset.hopHouse);
  const customName = detail.querySelector('[name="label"]');
  customName.value = 'custom draft'; customName.focus();
  await ac.refresh();
  check(detail.querySelector('[name="label"]') === customName && customName.value === 'custom draft' && document.activeElement === customName, 'full-card refresh rebuilt / defocused the custom house form');
  click(detail, '[data-action="apply"]');
  click(root, '[data-action="save"]'); await tick();
  ac.contentElement.querySelector('[data-agent-library]').open = true;
  click(ac.contentElement, '[data-agent-card-open="image_director"] .hop-title');
  check(ac.floatingAgentId === 'image_director', 'native catalog tile click was swallowed by interactive filter');
  ac.toggleFloatingAgentCard();
  let floating = ac.contentElement.querySelector('.agent-center-floating-card');
  floating.querySelector('[data-agent-prompt-rules]').value = 'catalog draft';
  await ac.refresh();
  floating = ac.contentElement.querySelector('.agent-center-floating-card');
  check(floating.querySelector('[data-agent-prompt-rules]').value === 'catalog draft', 'catalog editor did not retain draft');
  check(floating.querySelector('.agent-center-floating-face-front').inert, 'hidden catalog card face can receive input');
  check(ac.closeFloatingAgentCard() === false, 'catalog close discarded draft');
  await tick(); check(ac.floatingAgentId === 'image_director', 'cancel did not retain catalog card');
  allowDiscard = true; ac.closeFloatingAgentCard(); await tick();
  check(!ac.floatingAgentId, 'confirmed close failed');
  check(requests.length === 0, 'configuration invoked an executor');
  window.__agentCenterMigrationSmoke.openShared = openShared;
  window.__agentCenterMigrationSmoke.root = root;
  return { sharedPrompt: prompt.rules, memory: memoryPrompt.template, model: feature.modelProfileId, writes: writes.length, confirmations, previews: previews.map(item => item.agentId), requests: requests.length };
})()`);
assert.equal(result.sharedPrompt, 'shared draft');
assert.equal(result.model, 'profile-a');
assert.equal(result.requests, 0);
console.log('ok - shared prompt/model/memory editors, resource-scoped drafts, visible menus and catalog parity', result);
