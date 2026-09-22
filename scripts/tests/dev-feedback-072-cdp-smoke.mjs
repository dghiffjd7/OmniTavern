// Windows WebView only. Uses real UI modules with in-memory settings and no API calls.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { evaluateInApp, createWsClient, findAppPageTarget } from '../dev/cdp-client.mjs';

const setup = async (voiceOnly = false) => {
  const check = (condition, message) => { if (!condition) throw Error(message); };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const { AgentCenterPanel } = await import('/scripts/ui/agent-center-panel.js');
  const { createAgentConfigurationEditor } = await import('/scripts/ui/agent-configuration-editor.js');
  const { createAgentConfigStore } = await import('/scripts/storage/agent-config-store.js');
  const { createAgentConfigurationService } = await import('/scripts/agent/agent-configuration-service.js');
  const { mountAgentRequestPreview } = await import('/scripts/ui/chat/agent-request-preview.js');
  const { createMaidCommandInputRuntime } = await import('/scripts/ui/maid-command-input-runtime-utils.js');
  const { createRealtimeCallPanel } = await import('/scripts/ui/realtime/realtime-call-panel.js');
  const { createMaidSettingsPanel } = await import('/scripts/ui/maid-settings-panel.js');
  const { MaidSettingsStore } = await import('/scripts/storage/maid-settings-store.js');
  const memory = new Map(), storage = { getItem: key => memory.get(key), setItem: (key, value) => memory.set(key, value) };
  const context = { place: 'chat', scopeId: 'feedback-qa', sessionId: 'qa' };
  const store = createAgentConfigStore({ storage, saveKv: async () => true });
  let resolveModels, requested = [], voiceActions = [], voiceChoices = 0, submitted = [];
  const actions = createAgentConfigurationService({ store, runtime: { list: () => [] }, getContext: () => context,
    getProfiles: () => [{ id: 'a', name: '测试连接 A', model: 'default-a' }, { id: 'b', name: '测试连接 B', model: 'default-b' }],
    getInput: () => ({ before: '今天', after: '' }), getMessages: () => [],
  });
  actions.listProfileModels = id => { requested.push(id); return id === 'a' ? new Promise(resolve => { resolveModels = resolve; }) : Promise.resolve(['model-b', 'default-b']); };
  const ac = new AgentCenterPanel({ getActions: () => actions }); window.__feedback072 = { dispose: () => ac.destroy() }; ac.show(); await ac.refresh(); ac.hide();
  const host = document.createElement('div');
  host.className = 'agent-center-floating-layer';
  host.style.cssText = 'position:fixed;inset:16px;z-index:99990;pointer-events:auto;display:block';
  const shell = markup => { host.innerHTML = '<div class="agent-center-floating-card is-flipped" style="width:min(560px,100%);height:100%;max-height:none;margin:auto"><div class="agent-center-floating-inner"><div class="agent-center-floating-face agent-center-floating-face-back"><header>0.7.2 · UI 检查</header>' + markup + '</div></div></div>'; };
  shell('<div data-editor></div>'); document.body.append(host);
  let editor = createAgentConfigurationEditor({ actions, id: 'text_completion', context }); editor.attach(host.querySelector('[data-editor]'));
  const field = name => host.querySelector('[name="' + name + '"]');
  const changeProfile = value => { field('model').value = value; field('model').dispatchEvent(new Event('change', { bubbles: true })); };
  if (!voiceOnly) {
  changeProfile('a'); check(field('modelOverride').value === 'default-a', 'profile model is shown immediately');
  host.querySelector('[data-ac="pick-model"]').click(); await wait(20);
  changeProfile('b'); check(field('modelOverride').value === 'default-b', 'switching connection resets old override');
  resolveModels(['stale-a']); await wait(20);
  check(!document.querySelector('.world-app-select-item[data-value="stale-a"]'), 'late profile A response cannot appear in B');
  host.querySelector('[data-ac="pick-model"]').click(); await wait(40);
  const choice = document.querySelector('.world-app-select-item[data-value="model-b"]'); check(choice, 'fetched model is selectable'); choice.click();
  check(field('modelOverride').value === 'model-b', 'model choice updates draft');
  check(actions.getAgentConfiguration({ id: 'text_completion', context }).config.modelProfileId !== 'b', 'model draft is not persisted before Save');
  host.querySelector('[data-ac="save"]').click(); await wait(80);
  check(actions.getAgentConfiguration({ id: 'text_completion', context }).config.modelOverride === 'model-b', 'Save persists selected model');
  host.querySelector('.hop-request-open').click(); await wait(150);
  const assembled = host.querySelector('[data-agent-assembled-context]');
  changeProfile('a'); check(host.querySelector('[data-agent-assembled-context]') === assembled, 'rerender retains preview context DOM');
  host.querySelector('[data-request-action="close"]').click();
  }
  const geometry = async selector => {
    const scroll = host.querySelector('.hop-request-editor'), footer = host.querySelector(selector);
    for (const top of [0, scroll.scrollHeight / 2, scroll.scrollHeight]) {
      scroll.scrollTop = top; await wait(40);
      const a = scroll.getBoundingClientRect(), b = footer.getBoundingClientRect();
      check(Math.abs(a.bottom - b.bottom) <= 2, 'footer flush with scroll bottom: ' + JSON.stringify({ selector, top, bottom: a.bottom, footer: b.bottom }));
      check(document.elementFromPoint(b.x + 20, a.bottom - 2)?.closest(selector), 'no form content visible below footer');
    }
    return { width: host.getBoundingClientRect().width, footer: footer.getBoundingClientRect().bottom };
  };
  const common = voiceOnly ? null : await geometry('.ac-footer');
  const fixture = { host, ac, geometry, editor, requested, voiceActions, submitted,
    async showMemory() {
      editor.dispose(); shell(ac.renderMemoryAgentEditor({ id: 'memory_table_agent' }));
      this.memoryPreview = mountAgentRequestPreview({ host, buildRequest: async () => ({ messages: [{ role: 'system', content: '表格指导' }], sections: [{ source: '记忆' }] }) });
      host.querySelectorAll('details').forEach(node => { node.open = true; });
      await wait(80); return geometry('.agent-memory-save');
    },
    async showVoice() {
      host.hidden = true; host.style.display = 'none';
      const ball = document.createElement('button'); ball.style.cssText = 'position:fixed;left:50%;top:65%;width:30px;height:30px'; document.body.append(ball); this.ball = ball;
      let voiceState = { mode: 'realtime', recording: 'idle', call: 'idle' };
      const maid = createMaidCommandInputRuntime({ modeSwitchEl: ball, getViewportSize: () => ({ w: innerWidth, h: innerHeight }),
        getVoiceState: () => voiceState, onVoiceAction: action => voiceActions.push(action), onChooseVoiceMode: () => { voiceChoices++; },
        onAttachFiles: async () => [{ id: 'image', name: 'test.png', kind: 'image', mimeType: 'image/png', url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQ0AAAAASUVORK5CYII=' }],
        onSubmit: async (text, controls) => { submitted.push({ text, count: controls.attachments.length }); return { ok: true, message: '收到语音任务' }; },
      });
      this.maid = maid; maid.open({ autoFocus: false });
      const { inputEl, submitBtn } = maid.getElements();
      check(submitBtn.dataset.maidAction === 'realtime', 'empty maid composer offers Realtime');
      inputEl.value = '保留的草稿'; inputEl.dispatchEvent(new Event('input', { bubbles: true }));
      check(submitBtn.dataset.maidAction === 'send', 'draft changes button to Send');
      inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }));
      check(submitted.length === 0, 'IME Enter does not send');
      await maid.addFiles([new File(['x'], 'test.png', { type: 'image/png' })]);
      await maid.submitVoiceTask('打开设置');
      check(inputEl.value === '保留的草稿' && maid.getAttachments().length === 1, 'voice task preserves unsent draft and attachments');
      check(submitted[0].text === '打开设置' && submitted[0].count === 0, 'voice command goes through normal submission without draft attachment');
      inputEl.value = ''; inputEl.dispatchEvent(new Event('input', { bubbles: true }));
      check(submitBtn.dataset.maidAction === 'send', 'attachment-only remains Send');
      maid.clearAttachments();
      submitBtn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 1, clientY: 1 })); await wait(600);
      submitBtn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })); submitBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
      check(voiceChoices === 1 && voiceActions.length === 0, 'long press chooses mode without also dialing');
      voiceState = { mode: 'stt', recording: 'recording', call: 'idle' }; maid.syncVoiceState();
      check(submitBtn.dataset.maidAction === 'stop-recording', 'recording state offers Stop');
      voiceState = { mode: 'realtime', recording: 'idle', call: 'connecting' }; maid.syncVoiceState();
      check(submitBtn.dataset.maidAction === 'end-call', 'connecting state offers Cancel');
      voiceState.call = 'idle'; maid.syncVoiceState();
      const panel = createRealtimeCallPanel({ onExecuteTranscript: text => { this.handoff = text; } }); this.callPanel = panel;
      panel.show({ name: '女仆', uiMode: 'maid' }); panel.renderState({ status: 'listening', target: { uiMode: 'maid' } });
      const callLayer = document.querySelector('.realtime-call-layer.is-maid:not([hidden])');
      panel.setCaption({ role: 'user', text: '帮我打开 API 设置' });
      check(!callLayer.querySelector('[data-call-action="maid-task"]').disabled, 'spoken task handoff is available');
      panel.setCaption({ role: 'assistant', text: '可以，点击下方按钮交给我处理。' });
      await wait(250);
      for (const action of ['maid-task', 'end']) {
        const button = callLayer.querySelector('[data-call-action="' + action + '"]'), rect = button.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        check(button.contains(hit), 'composer cannot cover call control: ' + JSON.stringify({ action, rect: rect.toJSON(), layer: getComputedStyle(callLayer).zIndex, hit: hit?.outerHTML.slice(0, 350) }));
      }
      return { voiceChoices, calls: voiceActions.length, submitted };
    },
    async showVoiceSettings() {
      this.callPanel?.hide(); this.maid?.close();
      const settings = new MaidSettingsStore({ storage, loadKv: async () => null, saveKv: async () => {} }); await settings.load();
      const panel = createMaidSettingsPanel({ settingsStore: settings, listModelProfiles: () => [], onOpenVoiceConfig: () => {} }); this.settings = panel;
      panel.show({ tab: 'api' }); await wait(50);
      const overlay = panel.getElements().overlay;
      overlay.querySelector('[data-api-nav="voice"]').click();
      const mode = overlay.querySelector('[data-maid-voice-mode]'); check(mode?.value === 'realtime', 'voice preference is discoverable in settings');
      mode.value = 'stt'; mode.dispatchEvent(new Event('change', { bubbles: true })); await wait(30);
      check(settings.getVoiceInputMode() === 'stt', 'settings selector persists default mode');
    },
    dispose() { this.settings?.hide(); this.settings?.getElements().overlay?.remove(); this.callPanel?.destroy(); this.maid?.close(); this.maid?.getElements().rootEl?.remove(); this.ball?.remove(); this.memoryPreview?.dispose(); editor.dispose(); host.remove(); ac.destroy(); delete window.__feedback072; },
  };
  window.__feedback072 = fixture;
  return { common, profilesRequested: requested };
};

const target = await findAppPageTarget(); let socket, sequence = 0; const pending = new Map();
await new Promise((resolve, reject) => { socket = createWsClient(target.webSocketDebuggerUrl, { onOpen: resolve, onError: reject, onMessage: raw => {
  const message = JSON.parse(raw), task = pending.get(message.id); if (!task) return;
  pending.delete(message.id); clearTimeout(task.timer); message.error ? task.reject(Error(message.error.message)) : task.resolve(message.result);
} }); });
const command = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence, timer = setTimeout(() => reject(Error(method)), 25000); pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params })); });
const screenshot = async name => {
  await new Promise(resolve => setTimeout(resolve, 260)); // Wait for existing theme and panel transitions.
  const shot = await command('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`scripts/dev/tmp/feedback-072-${name}.png`, Buffer.from(shot.data, 'base64'));
};
try {
  await command('Emulation.setFocusEmulationEnabled', { enabled: true });
  const voiceOnly = process.argv.includes('--voice-only');
  console.log(await evaluateInApp(`(${setup.toString()})(${voiceOnly})`, { timeoutMs: 30000 }));
  if (!voiceOnly) {
  await screenshot('ac-desktop');
  console.log({ memory: await evaluateInApp('window.__feedback072.showMemory()') }); await screenshot('memory-desktop');
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 820, deviceScaleFactor: 1, mobile: true });
  console.log({ narrowMemory: await evaluateInApp('window.__feedback072.geometry(".agent-memory-save")') }); await screenshot('memory-mobile');
  }
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 820, deviceScaleFactor: 1, mobile: true });
  console.log(await evaluateInApp('window.__feedback072.showVoice()')); await screenshot('voice-mobile');
  await evaluateInApp('(async () => { const { themeManager } = await import("/scripts/ui/theme-manager.js"); const { themeStore } = await import("/scripts/storage/theme-store.js"); themeManager.applyThemePreset({preset:themeStore.getTheme("classic-dark"),mode:"dark"}); })()'); await screenshot('voice-dark');
  await evaluateInApp('window.__feedback072.showVoiceSettings()'); await screenshot('voice-settings-mobile');
  assert.equal(await evaluateInApp('document.documentElement.scrollWidth <= innerWidth + 1'), true);
  console.log('0.7.2 feedback UI smoke passed');
} catch (error) {
  await screenshot('failure').catch(() => {});
  throw error;
} finally {
  await evaluateInApp('window.__feedback072?.dispose()').catch(() => {});
  await evaluateInApp('(async () => { const { themeManager } = await import("/scripts/ui/theme-manager.js"); themeManager.applyCurrentTheme(); })()').catch(() => {});
  await command('Emulation.clearDeviceMetricsOverride').catch(() => {});
  await command('Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => {}); socket.close();
}
