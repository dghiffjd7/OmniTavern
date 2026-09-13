// Run against the Windows dev WebView. All writes use an isolated memory store;
// request builders and previews are real, but no model runtime is connected.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { evaluateInApp, createWsClient, findAppPageTarget } from '../dev/cdp-client.mjs';

const target = await findAppPageTarget();
let client, sequence = 0;
const pending = new Map();
await new Promise((resolve, reject) => {
  client = createWsClient(target.webSocketDebuggerUrl, {
    onOpen: resolve, onError: reject, onMessage: raw => {
      const message = JSON.parse(raw), job = pending.get(message.id);
      if (!job) return;
      pending.delete(message.id);
      message.error ? job.reject(Error(JSON.stringify(message.error))) : job.resolve(message.result);
    },
  });
});
const command = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence; pending.set(id, { resolve, reject });
  client.send(JSON.stringify({ id, method, params }));
});
const setup = async () => {
  const check = (value, label) => { if (!value) throw Error(label); };
  const same = (actual, expected, label) => check(JSON.stringify(actual) === JSON.stringify(expected), label);
  const wait = (ms = 60) => new Promise(resolve => setTimeout(resolve, ms));
  for (let attempt = 0; attempt < 200 && (!window.__chatappBootDiag?.runtimeReady || document.getElementById('app-splash')); attempt++) await wait(100);
  check(!document.getElementById('app-splash'), 'app is ready');
  const { createAgentConfigStore } = await import('/scripts/storage/agent-config-store.js');
  const { createAgentConfigurationService } = await import('/scripts/agent/agent-configuration-service.js');
  const { createAgentConfigurationEditor } = await import('/scripts/ui/agent-configuration-editor.js');
  const { getBuiltinAgentTask } = await import('/scripts/agent/agent-builtin-defaults.js');
  const { buildConfigurableInputMessages, buildAgentReferenceContext } = await import('/scripts/agent/agent-request-builder.js');
  const { buildChatFormatGuardianModelPrompt } = await import('/scripts/ui/chat/chat-format-guardian-utils.js');
  const { AgentCenterPanel } = await import('/scripts/ui/agent-center-panel.js');
  const { t } = await import('/scripts/i18n/index.js');
  const stylePanel = new AgentCenterPanel(); stylePanel.ensureStyle();
  const context = { place: 'writing', scopeId: 'builtin-defaults-smoke', sessionId: 'rp:builtin-defaults-smoke' };
  const memory = new Map(); let writes = 0, editor;
  const storage = { getItem: key => memory.get(key), setItem: (key, value) => { writes++; memory.set(key, value); } };
  const store = createAgentConfigStore({ storage });
  const input = { before: '窗外的雨', after: '渐渐停了。' };
  const message = { id: 'sample-reply', role: 'assistant', type: 'text', content: '<tableEdit>updateRow(0,0,{"1":"细雨"})</tableEdit>' };
  const formatRequest = config => buildChatFormatGuardianModelPrompt({
    assistantText: message.content, customFormatGuide: config.formatGuide, agentConfig: config,
    referenceContext: buildAgentReferenceContext([message], config.context, { targetMessageId: message.id }),
    surface: 'writing', baseRevision: 'builtin-defaults-smoke', parserReport: { status: 'ok' },
  });
  const actions = createAgentConfigurationService({
    store, getContext: () => context, getMessages: () => [message], getRaw: async m => m.content,
    getProfiles: () => [{ id: 'mock-profile', name: '隔离测试模型', model: 'mock-model' }], getInput: () => input,
    runtime: { list: () => [] }, buildFormatPreview: async ({ config }) => ({ ...formatRequest(config), params: { maxTokens: config.maxTokens, temperature: 0 } }),
  });
  const overlay = document.createElement('section'); overlay.className = 'agent-center-panel agent-builtin-defaults-smoke';
  overlay.style.cssText = 'display:block;position:fixed;inset:16px auto 16px 50%;transform:translateX(-50%);width:min(560px,calc(100vw - 24px));max-height:none;padding:18px;box-sizing:border-box;z-index:50000;overflow:auto;background:var(--app-surface-card);color:var(--app-text-primary);border:1px solid var(--app-border-default);border-radius:22px';
  const previousFocus = document.activeElement;
  document.body.append(overlay);
  const mount = id => {
    editor?.dispose(); editor = createAgentConfigurationEditor({ actions, id, context });
    overlay.replaceChildren(editor.node); overlay.scrollTop = 0; return editor;
  };
  const draft = () => JSON.parse(editor.node.querySelector('[name="agent-config-draft"]').value)[0];
  const field = (name, value) => {
    const element = editor.node.querySelector(`[name="${name}"]`);
    check(element, `field ${name} exists`); element.value = value;
    element.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const save = async () => {
    editor.node.querySelector('[data-ac="save"]').click();
    for (let attempt = 0; attempt < 80 && (editor.hasDraft() || editor.node.querySelector('[data-ac="save"]').disabled); attempt++) await wait(25);
    check(!editor.hasDraft(), `save completed: ${editor.node.querySelector('.ac-status').textContent}`);
  };
  window.__agentBuiltinDefaultsSmoke?.dispose();
  window.__agentBuiltinDefaultsSmoke = {
    get editor() { return editor; }, overlay, mount, t,
    dispose() {
      window.dispatchEvent(new Event('resize'));
      editor?.dispose(); overlay.remove(); stylePanel.destroy();
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
      delete window.__agentBuiltinDefaultsSmoke;
    },
  };
  for (const id of ['text_completion', 'reply_check']) {
    mount(id);
    same(editor.node.querySelector('[name="prompt"]').value, getBuiltinAgentTask(id), `${id} shows its real default task`);
    check(!editor.hasDraft() && !draft().prompt && !store.read(id, context).config.prompt && writes === 0, `${id} default display is not a write or draft`);
    same(editor.node.querySelector('[data-ac-ref-summary]').textContent, t('按需添加'), `${id} shows optional references`);
    same(editor.node.querySelector('[data-ac-section="context"] .ac-label').textContent, t('附加参考资料'), `${id} distinguishes additional references`);
    check([...editor.node.querySelectorAll('[data-ac-ref-field$=".enabled"]')].every(control => !control.checked), `${id} references are off by default`);
    check(editor.node.querySelectorAll('[data-ac-builtin-input]').length === (id === 'text_completion' ? 2 : 3), `${id} mandatory inputs are visible`);
    same(Number(editor.node.querySelector('[name="maxTokens"]').value), id === 'text_completion' ? 96 : 6000, `${id} exposes actual output limit`);
    const preview = await actions.buildAgentConfigurationPreview({ id, context });
    same(preview.messages, id === 'text_completion' ? buildConfigurableInputMessages({ ...input, settings: store.read(id, context).config }) : formatRequest(store.read(id, context).config).messages, `${id} default preview matches request builder`);
    check(writes === 0 && !editor.hasDraft(), `${id} preview leaves defaults inherited`);
  }
  mount('text_completion');
  const inputTask = '续写一句简短、自然的中文，衔接光标两边的内容。';
  field('prompt', inputTask);
  check(editor.hasDraft() && draft().taskPromptMode === 'replace', 'editing a builtin task is an explicit replacement');
  await save();
  let inputConfig = store.read('text_completion', context).config;
  same(inputConfig.prompt, inputTask, 'input task saved');
  same(inputConfig.taskPromptMode, 'replace', 'replacement mode saved');
  let preview = await actions.buildAgentConfigurationPreview({ id: 'text_completion', context });
  same(preview.messages, buildConfigurableInputMessages({ ...input, settings: inputConfig }), 'edited input preview matches request builder');
  same(preview.messages[0].content, inputTask, 'edited task reaches actual input request');
  const legacyTask = '只修改表格标签的闭合问题。';
  let record = actions.getAgentConfiguration({ id: 'reply_check', context });
  const legacyConfig = { ...record.config, prompt: legacyTask, maxTokens: 701,
    modelMode: 'profile', modelProfileId: 'mock-profile', modelOverride: 'mock-override',
    formatGuide: '表格更新放在 <tableEdit> 与 </tableEdit> 之间。',
    context: { ...record.config.context, history: { ...record.config.context.history, enabled: true, count: 3 } },
  };
  delete legacyConfig.taskPromptMode;
  check((await store.save({ id: 'reply_check', context, config: legacyConfig })).ok, 'legacy fixture saved in memory');
  mount('reply_check');
  same(editor.node.querySelector('[name="prompt"]').value, `${getBuiltinAgentTask('reply_check')}\n\n${legacyTask}`, 'legacy format task displays default plus its extension');
  check(!editor.hasDraft(), 'legacy effective task display is clean');
  field('maxTokens', 809); await save();
  let formatConfig = store.read('reply_check', context).config;
  same(formatConfig.prompt, legacyTask, 'saving a different field retains legacy stored extension');
  same(formatConfig.taskPromptMode, 'append', 'saving a different field retains legacy append behavior');
  preview = await actions.buildAgentConfigurationPreview({ id: 'reply_check', context });
  same(preview.messages[1], { role: 'system', content: legacyTask }, 'legacy extension remains a separate system message');
  const newTask = '检查当前表格编辑格式，只修复标签闭合与必要字段。';
  field('prompt', newTask); await save();
  formatConfig = store.read('reply_check', context).config;
  check(formatConfig.taskPromptMode === 'replace', 'format task edit switches to replacement');
  preview = await actions.buildAgentConfigurationPreview({ id: 'reply_check', context });
  same(preview.messages, formatRequest(formatConfig).messages, 'edited format preview matches request builder');
  check(preview.messages[0].content.startsWith(newTask) && preview.messages[0].content.includes('format_patch.v1'), 'edited task reaches format request and retains patch protocol');
  check(!preview.messages.some(item => item.content.includes(legacyTask)), 'replaced legacy task is absent');
  const preserved = config => ({ maxTokens: config.maxTokens, modelMode: config.modelMode, modelProfileId: config.modelProfileId,
    modelOverride: config.modelOverride, context: config.context, formatGuide: config.formatGuide, enabled: config.enabled });
  const settings = preserved(formatConfig);
  editor.node.querySelector('[data-ac="task-default"]').click();
  same(editor.node.querySelector('[name="prompt"]').value, getBuiltinAgentTask('reply_check'), 'restore task displays builtin immediately');
  same(preserved(draft()), settings, 'restore task preserves model, tokens, references, format guide and enabled setting');
  same(store.read('reply_check', context).config.prompt, newTask, 'restoring a draft waits for Save');
  await save();
  formatConfig = store.read('reply_check', context).config;
  same(preserved(formatConfig), settings, 'restored task preserves all unrelated saved settings');
  same(formatConfig.prompt, '', 'restored task uses the inherited default marker');
  mount('text_completion');
  editor.node.querySelector('[data-ac="task-default"]').click(); await save();
  inputConfig = store.read('text_completion', context).config;
  check(!inputConfig.prompt && !editor.hasDraft(), 'input reset restores default and clears draft');
  preview = await actions.buildAgentConfigurationPreview({ id: 'text_completion', context });
  same(preview.messages.length, 2, 'default input request has no duplicated output contract');
  const created = await actions.createTextEditAgent({ context, config: { prompt: '保留情节，让动作描写自然。' } });
  check(created.ok, 'custom fixture created'); mount(created.id);
  same(editor.node.querySelector('[name="prompt"]').value, '保留情节，让动作描写自然。', 'custom task is unchanged');
  check(!editor.node.querySelector('[data-ac="task-default"]') && !editor.node.querySelector('[data-ac-builtin-input]'), 'custom editor has no builtin-only controls');
  same(editor.node.querySelector('[data-ac-section="context"] .ac-label').textContent, t('参考资料'), 'custom reference heading is unchanged');
  same(editor.node.querySelector('[data-ac-ref-summary]').textContent, t('未添加'), 'custom reference summary is unchanged');
  mount('text_completion');
  editor.node.querySelector('[data-ac-section="context"]').open = true;
  editor.node.querySelector('[data-ac-ref-preview-button]').click(); await wait();
  same(editor.node.querySelector('[data-ac-ref-preview]').textContent.trim(), t('本次没有附加资料'), 'empty preview accurately describes additional references');
  editor.node.querySelector('[data-ac-section="context"]').open = false;
  return { defaultTasks: true, inheritedWithoutWrites: true, editedRequests: true, taskReset: true,
    legacyAppend: true, customUnchanged: true, additionalReferences: true, modelRequests: 0, memoryWrites: writes };
};

try {
  const result = await evaluateInApp(`(${setup.toString()})()`);
  assert.equal(result.taskReset, true); console.log(result);
  mkdirSync('scripts/dev/tmp', { recursive: true });
  const desktop = await command('Page.captureScreenshot', { format: 'png' });
  writeFileSync('scripts/dev/tmp/agent-builtin-defaults-desktop.png', Buffer.from(desktop.data, 'base64'));
  for (const width of [390, 320]) {
    await command('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: true });
    await command('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    const mobile = await evaluateInApp(`(async () => {
      const fixture = window.__agentBuiltinDefaultsSmoke, node = fixture.editor.node, overlay = fixture.overlay;
      const chip = node.querySelector('[data-ac-builtin-input]'); chip.scrollIntoView({ block: 'center' });
      await new Promise(resolve => setTimeout(resolve, 60));
      const rect = chip.getBoundingClientRect(), point = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      return { width: overlay.getBoundingClientRect().width, viewport: innerWidth, overflow: node.scrollWidth > node.clientWidth + 2,
        promptOverflow: node.querySelector('[name="prompt"]').getBoundingClientRect().right > overlay.getBoundingClientRect().right,
        resetTarget: node.querySelector('[data-ac="task-default"]').getBoundingClientRect().height, point, expectedHelp: chip.dataset.help };
    })()`);
    assert.ok(mobile.width <= mobile.viewport); assert.equal(mobile.overflow, false); assert.equal(mobile.promptOverflow, false);
    assert.ok(mobile.resetTarget >= 44);
    await command('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [mobile.point] });
    await command('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    const help = await evaluateInApp(`(async () => { await new Promise(resolve => setTimeout(resolve, 80)); const tip = document.querySelector('.app-help-tip.is-visible'); return { visible: Boolean(tip), text: tip?.querySelector('.app-help-tip__body')?.textContent || '', width: tip?.getBoundingClientRect().width || 0, viewport: innerWidth, aboveFixture: Boolean(tip && Number(getComputedStyle(tip).zIndex) > Number(getComputedStyle(window.__agentBuiltinDefaultsSmoke.overlay).zIndex)) }; })()`);
    assert.equal(help.visible, true); assert.equal(help.text, mobile.expectedHelp); assert.ok(help.width <= help.viewport); assert.equal(help.aboveFixture, true);
    console.log({ mobile: { width, fits: true, touchHelp: true } });
    const shot = await command('Page.captureScreenshot', { format: 'png' });
    writeFileSync(`scripts/dev/tmp/agent-builtin-defaults-${width}.png`, Buffer.from(shot.data, 'base64'));
    await evaluateInApp(`window.dispatchEvent(new Event('resize'))`);
  }
} finally {
  try { await command('Emulation.setTouchEmulationEnabled', { enabled: false }); await command('Emulation.clearDeviceMetricsOverride'); }
  finally { client.close(); await evaluateInApp('window.__agentBuiltinDefaultsSmoke?.dispose()'); }
}
