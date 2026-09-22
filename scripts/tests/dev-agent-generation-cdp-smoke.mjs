// Real Windows WebView UI; isolated in-memory settings and no model/network calls.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { evaluateInApp, createWsClient, findAppPageTarget } from '../dev/cdp-client.mjs';

const setup = async () => {
  const check = (condition, message) => { if (!condition) throw Error(message); };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const { AgentCenterPanel } = await import('/scripts/ui/agent-center-panel.js');
  const { createAgentConfigurationEditor } = await import('/scripts/ui/agent-configuration-editor.js');
  const { createAgentConfigStore } = await import('/scripts/storage/agent-config-store.js');
  const { createAgentConfigurationService } = await import('/scripts/agent/agent-configuration-service.js');
  const { createCustomAgentRequestRuntime } = await import('/scripts/agent/custom-agent-request-runtime.js');
  const { LLMClient } = await import('/scripts/api/client.js');
  const memory = new Map(), storage = { getItem: key => memory.get(key), setItem: (key, value) => memory.set(key, value) };
  const context = { place: 'chat', scopeId: 'generation-ui', sessionId: 'fixture' };
  const store = createAgentConfigStore({ storage });
  const profiles = [{ id: 'a', name: 'DeepSeek', provider: 'deepseek', model: 'deepseek-flash' },
    { id: 'b', name: 'Gemini', provider: 'vertexai', model: 'gemini-3.8-flash' }];
  await store.save({ id: 'text_completion', context, scope: 'global', config: { enabled: true, inputConsent: true, modelMode: 'profile', modelProfileId: 'a', invocationMode: 'both' } });
  let lastPreview, resolveInfo;
  const runtime = createCustomAgentRequestRuntime({ createClient: model => {
    const client = new LLMClient({ ...model, apiKey: 'fixture' });
    return { prepareChatRequest: client.prepareChatRequest.bind(client), chat: async () => { throw Error('Smoke must not call a model'); } };
  } });
  const actions = createAgentConfigurationService({ store, runtime: { list: () => [] }, getContext: () => context,
    getProfiles: () => profiles, getInput: () => ({ before: '今天想去', after: '' }), getMessages: () => [],
    captureModel: async config => profiles.find(item => item.id === config.modelProfileId),
    previewRequest: async ({ request, config }) => {
      lastPreview = await runtime.preview({ request, config, model: profiles.find(item => item.id === config.modelProfileId) });
      return lastPreview;
    },
  });
  const ac = new AgentCenterPanel({ getActions: () => actions }); ac.show(); await ac.refresh(); ac.hide();
  const host = document.createElement('div'); host.className = 'agent-center-floating-layer';
  host.style.cssText = 'position:fixed;inset:16px;z-index:99990;pointer-events:auto;display:block';
  host.innerHTML = '<div class="agent-center-floating-card is-flipped" style="width:min(560px,100%);height:100%;max-height:none;margin:auto"><div class="agent-center-floating-inner"><div class="agent-center-floating-face agent-center-floating-face-back"><header>输入建议 · 运行设置</header><div data-editor></div></div></div></div>';
  document.body.append(host);
  const editor = createAgentConfigurationEditor({ actions, id: 'text_completion', context }); editor.attach(host.querySelector('[data-editor]'));
  window.__agentGenerationUi = { dispose: () => { editor.dispose(); host.remove(); ac.destroy(); delete window.__agentGenerationUi; } };
  const field = name => host.querySelector('[name="' + name + '"]');
  const change = (name, value) => { const control = field(name); control.value = value; control.dispatchEvent(new Event('change', { bubbles: true })); };
  const choose = async (name, value) => {
    field(name).parentElement.querySelector('button').click(); await wait(25);
    const item = document.querySelector('.world-app-select-item[data-value="' + value + '"]'); check(item, 'menu option ' + name + '/' + value); item.click(); await wait(25);
  };
  await wait(80);
  host.querySelector('[data-ac-section="builtin-settings"]').open = true;
  check(field('reasoningMode').value === 'off' && field('maxTokens').value === '96' && field('timeoutSeconds').value === '12', 'legacy short autocomplete defaults');
  const prompt = field('prompt'), tokens = field('maxTokens');
  await choose('reasoningMode', 'on');
  check(field('maxTokens').value === '4096' && field('timeoutSeconds').value === '60', 'enable thinking raises short defaults');
  check(field('maxTokens') === tokens && field('prompt') === prompt, 'mode change preserves input and prompt DOM');
  await choose('reasoningEffort', 'low');
  tokens.focus(); tokens.value = '6000'; tokens.dispatchEvent(new Event('input', { bubbles: true })); await wait(100);
  check(document.activeElement === tokens, 'typing the budget keeps focus');
  change('timeoutSeconds', '150');
  check(store.read('text_completion', context).config.reasoningMode === 'off', 'editing has not persisted before Save');
  host.querySelector('[data-ac="save"]').click(); await wait(100);
  check(store.read('text_completion', context).config.maxTokens === 6000 && store.read('text_completion', context).config.timeoutSeconds === 150, 'save persists budget and wait');
  check(store.read('text_completion', { ...context, sessionId: 'other' }).config.reasoningMode === 'off', 'local changes do not leak into the global config');
  host.querySelector('.hop-request-open').click(); await wait(450);
  check(lastPreview?.wireRequest.body.thinking.type === 'enabled' && lastPreview.wireRequest.body.reasoning_effort === 'low', 'preview uses saved thinking mode and effort');
  check(lastPreview.wireRequest.body.max_tokens === 6000, 'preview respects the configured token budget');
  host.querySelector('[data-request-action="close"]').click();
  // An earlier metadata lookup must never change the newly selected model controls.
  actions.getAgentModelInfo = () => new Promise(resolve => { resolveInfo = resolve; });
  change('model', 'a'); const lateA = resolveInfo;
  actions.getAgentModelInfo = async () => profiles[1]; change('model', 'b'); await wait(60);
  lateA(profiles[0]); await wait(30);
  check(field('reasoningEffort').querySelector('[value="medium"]') && !field('reasoningEffort').querySelector('[value="max"]'), 'late DeepSeek capabilities do not overwrite Gemini controls');
  actions.getAgentModelInfo = async () => profiles[0]; change('model', 'a'); await wait(60);
  await choose('reasoningMode', 'off'); await choose('reasoningMode', 'on');
  check(field('maxTokens').value === '6000' && field('timeoutSeconds').value === '150', 'custom budget/wait survive toggling');
  const position = async () => {
    host.querySelector('[data-ac-section="builtin-settings"]').open = true;
    field('reasoningMode').parentElement.scrollIntoView({ block: 'center', behavior: 'instant' }); await wait(100);
    check(document.documentElement.scrollWidth <= innerWidth + 1, 'no viewport overflow');
    const bounds = host.getBoundingClientRect();
    for (const name of ['maxTokens', 'timeoutSeconds']) { const rect = field(name).getBoundingClientRect(); check(rect.left >= bounds.left && rect.right <= bounds.right, 'field fits within mobile card: ' + name); }
    return { width: innerWidth, maxTokens: field('maxTokens').value, timeout: field('timeoutSeconds').value };
  };
  Object.assign(window.__agentGenerationUi, { position });
  await position();
  return { defaults: true, providerControls: true, stableFocus: true, savedScope: true, preview: true, staleModelGuard: true };
};

const target = await findAppPageTarget(); let socket, sequence = 0; const pending = new Map();
await new Promise((resolve, reject) => { socket = createWsClient(target.webSocketDebuggerUrl, { onOpen: resolve, onError: reject, onMessage: raw => {
  const message = JSON.parse(raw), task = pending.get(message.id); if (!task) return;
  pending.delete(message.id); clearTimeout(task.timer); message.error ? task.reject(Error(message.error.message)) : task.resolve(message.result);
} }); });
const command = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence, timer = setTimeout(() => reject(Error(method)), 20000); pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params })); });
const screenshot = async name => {
  await new Promise(resolve => setTimeout(resolve, 260));
  const shot = await command('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`scripts/dev/tmp/agent-generation-${name}.png`, Buffer.from(shot.data, 'base64'));
};
try {
  await command('Emulation.setFocusEmulationEnabled', { enabled: true });
  assert.equal((await evaluateInApp(`(${setup.toString()})()`, { timeoutMs: 30000 })).preview, true);
  await screenshot('desktop');
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 820, deviceScaleFactor: 1, mobile: true });
  console.log(await evaluateInApp('window.__agentGenerationUi.position()')); await screenshot('mobile');
  await evaluateInApp('(async () => { const { themeManager } = await import("/scripts/ui/theme-manager.js"); const { themeStore } = await import("/scripts/storage/theme-store.js"); themeManager.applyThemePreset({preset:themeStore.getTheme("classic-dark"),mode:"dark"}); })()');
  await screenshot('dark');
  console.log('Agent generation UI passed: dropdowns, budget/wait defaults, focus, scoped save, preview, stale model lookup and narrow layout');
} catch (error) { await screenshot('failure').catch(() => {}); throw error; }
finally {
  await evaluateInApp('window.__agentGenerationUi?.dispose()').catch(() => {});
  await evaluateInApp('(async () => { const { themeManager } = await import("/scripts/ui/theme-manager.js"); themeManager.applyCurrentTheme(); })()').catch(() => {});
  await command('Emulation.clearDeviceMetricsOverride').catch(() => {});
  await command('Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => {}); socket.close();
}
