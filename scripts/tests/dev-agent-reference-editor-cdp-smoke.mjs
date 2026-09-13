// Windows WebView smoke: isolated in-memory Agent and catalogs; no user data or model requests.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { evaluateInApp, createWsClient, findAppPageTarget } from '../dev/cdp-client.mjs';

const result = await evaluateInApp(`(async () => {
  const { createAgentConfigurationEditor } = await import('/scripts/ui/agent-configuration-editor.js');
  const { normalizeAgentConfiguration } = await import('/scripts/storage/agent-config-store.js');
  const { AgentCenterPanel } = await import('/scripts/ui/agent-center-panel.js');
  new AgentCenterPanel().ensureStyle();
  const check = (value, message) => { if (!value) throw Error(message); };
  const wait = (ms = 230) => new Promise(resolve => setTimeout(resolve, ms));
  const ctx = { place: 'writing', sessionId: 'rp:reference-smoke', scopeId: 'reference-smoke' };
  const id = 'text-edit:reference-smoke';
  let config = normalizeAgentConfiguration({ id, title: '正文优化', enabled: true, modelMode: 'follow_current', invocationMode: 'auto', outputMode: 'edit', prompt: '保留人物与情节，让正文自然、具体。', target: { mode: 'rendered' },
    context: { mode: 'none', maxChars: 10000, history: { enabled: false, unit: 'turns', count: 3, roles: ['user','assistant'], includeTarget: true }, worldbook: { enabled: false, ids: [] }, prompts: { enabled: false, ids: [] } },
    tools: { enabled: false, ids: [], maxRounds: 4 } }, id);
  let sourceCalls = 0, toolCalls = 0, bookCalls = 0, lastPreview = null, revision = 0;
  const whole = { id: 'worldbook:atlas', kind: 'worldbook', title: '港城设定', group: '港城', bookId: 'atlas', whole: true, hasChildren: true, entriesLoaded: false, available: true };
  const entry = { id: 'worldbook:atlas:harbor', kind: 'worldbook', title: '旧港口', group: '港城', bookId: 'atlas', whole: false, available: true };
  const prompt = { id: 'preset:style', kind: 'prompt', title: '克制、自然的叙述', group: '当前预设', available: true };
  let jobs = [{ id: 'note-1', agentId: id, sessionId: ctx.sessionId, context: ctx, status: 'ready', outputMode: 'note', text: '可保留港口的动作细节，删去重复解释。', createdAt: Date.now(), trace: { reasoning: '核对了提供的背景与正文。', steps: [
    { id: 'model-1', kind: 'model', label: '分析正文', status: 'succeeded' },
    { id: 'tool-1', kind: 'tool', label: '查找世界书', status: 'succeeded', input: { query: '港口' }, output: '旧港口在城南。', durationMs: 75 },
  ], truncated: false } }];
  const actions = {
    getAgentConfiguration: () => ({ id, scope: 'local', context: ctx, config: structuredClone(config), bodyRule: { mode: 'tags', start: '<content>', end: '</content>' }, profiles: [], revision: String(revision), bodyRevision: '0', currentModelLabel: 'Gemini · 示例' }),
    getAgentCurrentModelLabel: async () => 'Gemini · 示例',
    listTextEditRuns: () => jobs, listInputAgentRuns: () => [],
    listAgentReferenceSources: async options => { sourceCalls++; await wait(20); if (options.worldbookId) bookCalls++; return bookCalls ? [{ ...whole, entriesLoaded: true }, entry, prompt] : [whole, prompt]; },
    listAgentAvailableTools: async () => { toolCalls++; await wait(20); return [{ id: 'worldbook.search', label: '查找世界书', description: '按关键词查找世界书条目。', category: '资料', available: true }, { id: 'web.search', label: '搜索网页', reason: '请在当前模型配置中开启联网', available: false }]; },
    previewAgentReferenceContext: async options => { lastPreview = structuredClone(options); await wait(20); return { text: '只读参考：前两轮与本轮用户输入。旧港口在城南。', chars: 28, sources: [{ id: 'history', kind: 'history', title: '最近三轮', status: 'included', chars: 18 }, { ...entry, status: 'included', chars: 10 }], warnings: [], truncated: false }; },
    saveAgentConfiguration: async options => { config = structuredClone(options.config); revision++; return { ok: true }; },
    getAgentTargetPreview: async () => ({ raw: '<content>她走进旧港口。</content>', messageId: 'latest', target: { ok: true, mode: 'rendered', text: '她走进旧港口。' } }),
    ignoreTextEditRun: jobId => { jobs = jobs.map(job => job.id === jobId ? { ...job, status: 'ignored' } : job); window.dispatchEvent(new Event('agent-text-edit-changed')); },
  };
  const overlay = document.createElement('section'); overlay.className = 'agent-center-panel agent-reference-smoke';
  overlay.style.cssText = 'display:block;position:fixed;inset:16px auto 16px 50%;transform:translateX(-50%);width:min(540px,calc(100vw - 24px));max-height:none;padding:18px;box-sizing:border-box;z-index:999999;overflow:auto;background:var(--app-surface-card);color:var(--app-text-primary);border:1px solid var(--app-border-default);border-radius:22px';
  const editor = createAgentConfigurationEditor({ actions, id, context: ctx }); overlay.append(editor.node); document.body.append(overlay);
  window.__agentReferenceSmoke = { editor, overlay, cleanup() { editor.dispose(); overlay.remove(); delete window.__agentReferenceSmoke; } };
  const root = editor.node;
  check(sourceCalls === 0 && toolCalls === 0, 'catalogs are lazy');
  root.querySelector('[data-ac-section="context"]>summary').click(); await wait();
  check(sourceCalls === 1, 'opening references loads one catalog');
  root.querySelector('[data-ac-ref-field="history.enabled"]').click(); await wait(20);
  check(root.querySelector('[data-ac-ref-count="3"]').getAttribute('aria-pressed') === 'true', 'three rounds selected');
  root.querySelector('[data-ac-ref-field="worldbook.enabled"]').click(); await wait(20);
  root.querySelector('[data-ac-section="references-worldbook"]>summary').click(); await wait();
  root.querySelector('[data-source-id="worldbook:atlas"][data-ac-ref-source]').click();
  root.querySelector('[data-ac-ref-book="atlas"]').click(); await wait(70);
  check(bookCalls === 1 && root.querySelector('[data-source-id="worldbook:atlas:harbor"][data-ac-ref-source]'), 'worldbook entries load on demand');
  root.querySelector('[data-source-id="worldbook:atlas:harbor"][data-ac-ref-source]').click();
  check(!root.querySelector('[data-source-id="worldbook:atlas"][data-ac-ref-source]').checked, 'entry replaces whole-book selection');
  root.querySelector('[data-ac-ref-field="prompts.enabled"]').click(); await wait(20);
  root.querySelector('[data-ac-section="references-prompts"]>summary').click(); await wait();
  root.querySelector('[data-ac-ref-source="prompts"]').click();
  root.querySelector('[data-ac-ref-preview-button]').click(); await wait(60);
  check(lastPreview.config.context.history.count === 3 && lastPreview.config.context.history.includeTarget, 'preview receives readonly window with current turn');
  check(lastPreview.config.context.worldbook.ids.join() === entry.id && lastPreview.config.context.prompts.ids.join() === prompt.id, 'selected sources are explicit');
  check(root.querySelector('[data-ac-ref-preview]').textContent.includes('最近三轮'), 'reference manifest visible');
  const previewText = root.querySelector('[data-ac-section="reference-content"]'); previewText.querySelector('summary').click(); await wait();
  check(previewText.querySelector('pre').textContent.includes('只读参考'), 'actual reference text expandable');
  root.querySelector('[data-ac-section="tools"]>summary').click(); await wait();
  root.querySelector('[data-ac-tools-enabled]').click(); await wait(60);
  check(toolCalls === 1 && root.querySelector('[data-ac-tool-id="web.search"]').disabled, 'network-gated tool shows unavailable state');
  root.querySelector('[data-ac-tool-id="worldbook.search"]').click();
  const output = root.querySelector('[name="outputMode"]'); output.value = 'note'; output.dispatchEvent(new Event('change', { bubbles: true }));
  root.querySelector('[data-ac="save"]').click(); await wait(80);
  check(config.outputMode === 'note' && config.tools.ids.join() === 'worldbook.search', 'note mode and tool allowlist saved');
  check(config.context.worldbook.ids.join() === entry.id && config.context.history.unit === 'turns', 'reference controls persist through save');
  check(root.querySelector('.ac-run-note') && !root.querySelector('[data-ac^="review:"]'), 'note card has no rewrite action');
  check(!root.querySelector('.ac-run-step'), 'execution steps are lazy');
  root.querySelector('[data-ac-run-detail="note-1:trace"]>summary').click(); await wait();
  check(root.querySelectorAll('.ac-run-step').length === 2, 'execution steps expand');
  const reasoning = root.querySelector('[data-ac-run-detail="note-1:reasoning"]');
  check(!reasoning.querySelector('pre'), 'reasoning text stays lazy'); reasoning.querySelector('summary').click(); await wait();
  check(reasoning.querySelector('pre').textContent === jobs[0].trace.reasoning, 'only provider reasoning shown');
  root.querySelector('[data-ac-run-detail="note-1:step:tool-1"]>summary').click(); await wait();
  const firstCard = root.querySelector('.ac-run-card'); window.dispatchEvent(new Event('agent-text-edit-changed'));
  check(root.querySelector('.ac-run-card') === firstCard && root.querySelector('[data-ac-run-detail="note-1:step:tool-1"]').open, 'unchanged runs keep DOM and expanded state');
  jobs = [{ ...jobs[0], message: '资料已整理' }]; window.dispatchEvent(new Event('agent-text-edit-changed')); await wait(20);
  check(root.querySelector('[data-ac-run-detail="note-1:step:tool-1"]').open, 'trace update retains expanded step');
  document.body.dataset.reducedMotion = 'on';
  const details = root.querySelector('[data-ac-section="more"]'); details.querySelector('summary').click(); await wait(20);
  check(details.open && !details.getAnimations().length, 'reduced motion uses native disclosure'); delete document.body.dataset.reducedMotion;
  root.querySelector('[data-ac-section="context"]').scrollIntoView({ block: 'start' });
  return { lazyCatalog: true, worldbookEntries: true, readonlyWindow: true, explicitSources: true, noteMode: true, tools: true, trace: true, reducedMotion: true, sourceCalls, toolCalls };
})()`);
assert.equal(result.trace, true); console.log(result);

const target = await findAppPageTarget(); let client, seq = 0; const pending = new Map();
await new Promise((resolve, reject) => { client = createWsClient(target.webSocketDebuggerUrl, { onOpen: resolve, onError: reject, onMessage: raw => { const message = JSON.parse(raw), job = pending.get(message.id); if (!job) return; pending.delete(message.id); message.error ? job.reject(Error(JSON.stringify(message.error))) : job.resolve(message.result); } }); });
const command = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); client.send(JSON.stringify({ id, method, params })); });
try {
  const desktop = await command('Page.captureScreenshot', { format: 'png' }); writeFileSync('scripts/dev/tmp/agent-reference-desktop.png', Buffer.from(desktop.data, 'base64'));
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  const mobile = await evaluateInApp(`(() => { const root = window.__agentReferenceSmoke.editor.node; const overlay = window.__agentReferenceSmoke.overlay; root.querySelector('[data-ac-section="context"]').scrollIntoView({block:'start'}); return { width: overlay.getBoundingClientRect().width, viewport: innerWidth, overflow: root.scrollWidth > root.clientWidth + 2, targets: [...root.querySelectorAll('.ac-reference-heading label')].every(label => label.getBoundingClientRect().height >= 44) }; })()`);
  assert.ok(mobile.width <= mobile.viewport); assert.equal(mobile.overflow, false); assert.equal(mobile.targets, true); console.log({ mobile });
  const phone = await command('Page.captureScreenshot', { format: 'png' }); writeFileSync('scripts/dev/tmp/agent-reference-mobile.png', Buffer.from(phone.data, 'base64'));
} finally { await command('Emulation.clearDeviceMetricsOverride'); client.close(); await evaluateInApp('window.__agentReferenceSmoke?.cleanup()'); }
