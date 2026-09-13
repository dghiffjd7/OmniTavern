// Windows dev WebView; all configurations, model responses and messages are isolated in memory.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { evaluateInApp, createWsClient, findAppPageTarget } from '../dev/cdp-client.mjs';

const result = await evaluateInApp(`(async () => {
  for (let attempt = 0; attempt < 250 && (!window.__chatappBootDiag?.runtimeReady || document.getElementById('app-splash')); attempt++) await new Promise(r => setTimeout(r, 100));
  if (document.getElementById('app-splash')) throw Error('App is still starting');
  const check = (condition, label) => { if (!condition) throw Error(label); };
  const { createAgentConfigStore } = await import('/scripts/storage/agent-config-store.js');
  const { createAgentConfigurationService } = await import('/scripts/agent/agent-configuration-service.js');
  const { createTextEditRuntime } = await import('/scripts/agent/text-edit-runtime.js');
  const { AgentCenterPanel } = await import('/scripts/ui/agent-center-panel.js');
  const { createScopedHopscotchBoardStore } = await import('/scripts/storage/hopscotch-board-store.js');
  const { createHopscotchTurnRuntime } = await import('/scripts/ui/chat/hopscotch-turn-runtime.js');
  const { createHopscotchBoardPanel } = await import('/scripts/ui/chat/hopscotch-board-panel.js');
  const { resolveAgentTextTargetAsync } = await import('/scripts/agent/agent-text-target.js');
  const ctx = { place: 'writing', scopeId: 'agent-smoke', sessionId: 'rp:agent-smoke' }, memory = new Map();
  const storage = { getItem: k => memory.get(k), setItem: (k, v) => memory.set(k, v) };
  const store = createAgentConfigStore({ storage }), bodyRule = { mode: 'tags', start: '<body>', end: '</body>' };
  let message = { id: 'sample', role: 'assistant', type: 'text', rawOriginal: '<think>构思</think><body>雨落在窗沿。她静静读着一封信。</body><tableEdit>updateRow(0,0,{"1":"x"})</tableEdit>' };
  message.content = message.rawOriginal;
  let older = { ...message, id: 'older', content: '<body>第一行。\\r\\n旧回复第二行。</body>', rawOriginal: '<body>第一行。\\r\\n旧回复第二行。</body>' };
  let modelCalls = 0, committed = 0;
  const runtime = createTextEditRuntime({ getContext: () => ctx, getMessage: mid => mid === older.id ? older : message, getMessages: () => [older, message], getRaw: async m => m.rawOriginal,
    getConfig: id => store.read(id, ctx).config, getBodyRule: () => bodyRule, captureModel: async () => ({}),
    request: async req => { modelCalls++; const target = JSON.parse(req.messages.at(-1).content).target; return JSON.stringify({ protocolVersion:'format_patch.v1',baseRevision:req.baseRevision,status:'patch',repairSummary:'调整语气',linePatches:[{startLine:1,endLine:1,originalLines:[target],replacementLines:['细雨轻敲窗沿。她垂眸，读着那封信。']}] }); },
    review: async options => ({ confirmed: true, changed: true, candidateText: '细雨轻敲窗沿。她垂眸，读着那封信。' }),
    commit: async ({ text }) => { committed++; message = { ...message, rawOriginal: text, content: text }; return true; },
    onChange: () => window.dispatchEvent(new CustomEvent('agent-text-edit-changed')),
  });
  const actions = createAgentConfigurationService({ store, runtime, getContext: () => ctx, getMessages: () => [older, message], getRaw: async m => m.rawOriginal,
    getProfiles: () => [{ id: 'mock', name: '轻量模型 · 示例' }], buildFormatPreview: async () => ({ messages: [] }), getInput: () => ({ before: '今天', after: '' }) });
  const created = await actions.createTextEditAgent({ context: ctx, config: { target: { mode: 'body' } } });
  let record = actions.getAgentConfiguration({ id: created.id, context: ctx });
  await actions.saveAgentConfiguration({ ...record, config: { ...record.config, modelMode: 'profile', modelProfileId: 'mock', enabled: true, invocationMode: 'both' }, bodyRule });
  let board;
  const ac = new AgentCenterPanel({ getActions: () => actions, getHopscotchPanel: () => board });
  const boardStore = createScopedHopscotchBoardStore({ storage, getSessionSettings: () => ({}), setSessionSettings: async () => true });
  const workflow = createHopscotchTurnRuntime({ boardStore, getTextAgents: () => store.list(ctx).filter(r => r.config.kind === 'text_edit').map(r => r.config) });
  board = createHopscotchBoardPanel({ embedded: true, boardStore, runtime: workflow, getSessionId: () => ctx.sessionId, getPlace: () => 'writing', onOpen: () => ac.show(), mountAgentCard: (host, options) => ac.mountHopscotchAgentCard(host, options) });
  const fixture = { ac, board, store, actions, runtime, id: created.id, ctx, get message() { return message; }, get calls() { return modelCalls; },
    dispose() { ac.destroy(); board.dispose(); runtime.dispose(); delete window.__agentConfigSmoke; } };
  window.__agentConfigSmoke?.dispose(); window.__agentConfigSmoke = fixture;
  ac.show({ tab: 'agents' }); await ac.refresh();
  check(ac.contentElement.querySelector('[data-hop-kind="text_edit"]'), 'custom house is visible');
  ac.openFloatingAgentCard(created.id); ac.toggleFloatingAgentCard();
  let editor = ac.contentElement.querySelector('.agent-config-editor');
  check(editor, 'common editor mounted');
  const field = editor.querySelector('[name="prompt"]'); field.value = '保留情节，让叙述更自然。'; field.dispatchEvent(new Event('input', { bubbles: true }));
  const priorNode = editor; await ac.refresh(); editor = ac.contentElement.querySelector('.agent-config-editor');
  check(editor === priorNode && editor.querySelector('[name="prompt"]').value === field.value, 'refresh preserves draft and DOM');
  editor.querySelector('[data-ac="target-preview"]').click(); await new Promise(r => setTimeout(r, 70));
  check(editor.querySelector('mark')?.textContent === '雨落在窗沿。她静静读着一封信。', 'target preview excludes surrounding tags');
  editor.querySelector('[data-ac="save"]').click(); await new Promise(r => setTimeout(r, 70));
  check(store.read(created.id, ctx).config.prompt === field.value, 'editor saves common config');
  const handle = ac.contentElement.querySelector('.hop-request-open'); check(handle, 'vertical preview handle mounted'); handle.click(); await new Promise(r => setTimeout(r, 80));
  check(ac.contentElement.querySelector('.hop-request-scroll').textContent.includes('保留情节'), 'preview assembles unsaved/saved task using same request builder');
  ac.contentElement.querySelector('[data-request-action="close"]').click();
  editor.querySelector('[data-ac="run"]').click(); await new Promise(r => setTimeout(r, 140));
  check(modelCalls === 1 && committed === 0, 'manual run produces candidate without automatic write');
  check(runtime.list().at(-1).status === 'ready', 'candidate is ready');
  await runtime.open(runtime.list().at(-1).id);
  check(committed === 1 && message.rawOriginal.startsWith('<think>构思</think><body>') && message.rawOriginal.endsWith('</tableEdit>'), 'confirmed edit preserves surrounding raw content');
  const regex = await resolveAgentTextTargetAsync('<body>test</body>', { mode:'regex', pattern:'<body>(.*?)</body>', group:1 });
  check(regex.ok && regex.text === 'test', 'advanced regex worker resolves exact span');
  check(modelCalls === 1, 'preview and config never call model');
  ac.closeFloatingAgentCard({ force: true });
  ac.openFloatingAgentCard(created.id, { messageId: older.id, scope: 'local', context: ctx }); ac.toggleFloatingAgentCard();
  editor = ac.contentElement.querySelector('.agent-config-editor'); await new Promise(r => setTimeout(r, 100));
  editor.querySelector('[data-ac="target-preview"]').click(); await new Promise(r => setTimeout(r, 80));
  check(editor.querySelector('mark')?.textContent.includes('旧回复'), 'expanding the target previews the pinned message');
  editor.querySelector('[data-ac="raw-selection"]').click(); await new Promise(r => setTimeout(r, 70));
  const area = editor.querySelector('[name="raw-selection"]'), offset = area.value.indexOf('旧回复');
  area.setSelectionRange(offset, offset + '旧回复第二行。'.length); editor.querySelector('[data-ac="use-selection"]').click();
  editor.querySelector('[data-ac="run"]').click(); await new Promise(r => setTimeout(r, 120));
  const selectedRun = runtime.list().at(-1);
  check(selectedRun.messageId === older.id && selectedRun.status === 'ready' && modelCalls === 2 && committed === 1, 'raw selection with CRLF produces a candidate for the older message');
  runtime.ignore(selectedRun.id);
  return { editor: true, draftPreserved: true, preview: true, exactTarget: true, modelCalls, committed, regexWorker: true, olderMessageSelection: true };
})()`);
assert.equal(result.editor, true); console.log(result);

const page = await findAppPageTarget(); let client, seq = 0; const pending = new Map();
await new Promise((resolve, reject) => {
  client = createWsClient(page.webSocketDebuggerUrl, { onOpen: resolve, onError: reject, onMessage: raw => {
    const message = JSON.parse(raw), job = pending.get(message.id); if (!job) return;
    pending.delete(message.id); message.error ? job.reject(Error(JSON.stringify(message.error))) : job.resolve(message.result);
  } });
});
const command = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); client.send(JSON.stringify({ id, method, params })); });
try {
  const desktop = await command('Page.captureScreenshot', { format: 'png' });
  writeFileSync('scripts/dev/tmp/agent-config-desktop.png', Buffer.from(desktop.data, 'base64'));
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 820, deviceScaleFactor: 1, mobile: true });
  const mobile = await evaluateInApp(`(async () => {
    const ac = window.__agentConfigSmoke.ac;
    ac.contentElement.querySelector('.hop-request-open').click(); await new Promise(r => setTimeout(r, 120));
    const card = ac.contentElement.querySelector('.agent-center-floating-card'), workspace = ac.contentElement.querySelector('.hop-request-workspace');
    return { mode: workspace.dataset.preview, width: card.getBoundingClientRect().width, viewport: innerWidth };
  })()`);
  assert.equal(mobile.mode, 'full'); assert.ok(mobile.width <= mobile.viewport + 1); console.log({ mobile });
  const phone = await command('Page.captureScreenshot', { format: 'png' });
  writeFileSync('scripts/dev/tmp/agent-config-mobile.png', Buffer.from(phone.data, 'base64'));
  await evaluateInApp(`(async () => {
    const root = window.__agentConfigSmoke.ac.contentElement;
    root.querySelector('[data-request-action="close"]').click();
    root.querySelector('[name="target.mode"]').closest('label').scrollIntoView({ block: 'start' });
    await new Promise(r => setTimeout(r, 120));
  })()`);
  const mobileEditor = await command('Page.captureScreenshot', { format: 'png' });
  writeFileSync('scripts/dev/tmp/agent-config-mobile-editor.png', Buffer.from(mobileEditor.data, 'base64'));
} finally {
  await command('Emulation.clearDeviceMetricsOverride'); client.close();
  await evaluateInApp('window.__agentConfigSmoke?.dispose()');
}
