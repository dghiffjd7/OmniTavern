// Production toolbox/configuration/runtime/reviewer; isolated in-memory data and
// a deterministic model port. Never sends an API request or edits user data.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { evaluateInApp, createWsClient, findAppPageTarget } from '../dev/cdp-client.mjs';

const setup = async () => {
  window.__formatToolsSmoke?.dispose();
  window.appBridge.debugUiRegistry.stores.agentToolsRuntime.toolbox.close();
  const { createAgentToolsAppRuntime } = await import('/scripts/ui/agent-tools-app-runtime.js');
  const { createAgentConfigStore } = await import('/scripts/storage/agent-config-store.js');
  const { saveFormatRepairProfileDraft, createFormatRepairProfileDraft } = await import('/scripts/agent/format-repair-profiles.js');
  const { createAgentConfigurationEditor } = await import('/scripts/ui/agent-configuration-editor.js');
  const { createCodeViewerUiRuntime } = await import('/scripts/ui/chat/code-viewer-ui-utils.js');
  const { bindBubbleTextSelection } = await import('/scripts/ui/chat/bubble-text-selection.js');
  const { createLongPressUiRuntime } = await import('/scripts/ui/chat/long-press-ui-utils.js');
  const { validateFormatRepairWriteScope } = await import('/scripts/agent/format-repair-selection.js');
  const { buildFormatRepairRequest } = await import('/scripts/agent/format-repair-request.js');
  const check = (ok, label) => { if (!ok) throw Error(label); };
  const pause = (ms = 60) => new Promise(resolve => setTimeout(resolve, ms));
  const context = { place: 'writing', scopeId: '', sessionId: 'rp:format-smoke', archiveId: 'one' };
  const table = '<tableEdit>insertRow(0,{"0":"已记录"})\nupdateRow(0,0,{"1":"待修复",})</tableEdit>';
  const raw = '<p>窗边的灯光照着摊开的书页。她抬起头，看到晚风拂过窗帘。</p>\r\n' + table + '\r\n<p>其余内容保持原样。</p>';
  let message = { id: 'format-latest', role: 'assistant', content: '窗边的灯光照着摊开的书页。她抬起头，看到晚风拂过窗帘。', rawOriginal: raw, meta: { activeSwipe: 0 } };
  const older = { id: 'format-older', role: 'assistant', content: '前一轮回复', rawOriginal: '<p>前一轮回复</p>' };
  const requests = [], commits = [], storage = { getItem: () => null, setItem() {} };
  const store = createAgentConfigStore({ storage, onChange: () => window.dispatchEvent(new Event('agent-feature-settings-changed')) });
  await store.save({ id: 'reply_check', context, config: { enabled: true, invocationMode: 'both', modelMode: 'follow_current', formatGuide: '保留回复结构' } });
  const draft = createFormatRepairProfileDraft(store.read('reply_check', context).config, 'tableEdit'); draft.repairProfileName = '表格指令';
  await store.save({ id: 'reply_check', context, config: saveFormatRepairProfileDraft(draft, { id: draft.repairProfileId, name: draft.repairProfileName }) });
  const profileId = draft.repairProfileId;
  const host = document.createElement('section'); host.dataset.formatSmoke = '';
  host.style.cssText = 'position:fixed;z-index:21500;inset:0;display:flex;flex-direction:column;background:var(--app-surface-page);color:var(--app-text-primary)';
  host.innerHTML = '<header style="padding:18px;border-bottom:1px solid var(--app-border-default)">格式修复 · 实际组件验证</header><div data-scroll style="flex:1;min-height:0;overflow:auto;padding:24px"><div data-msg-id="format-older" data-role="assistant" style="margin:0 auto 28px;max-width:650px"><div class="QQ_chat_msgdiv">前一轮回复</div></div><div data-msg-id="format-latest" data-role="assistant" style="margin:0 auto;max-width:650px"><div class="QQ_chat_msgdiv" style="background:var(--app-surface-card);padding:18px;border-radius:16px;line-height:1.9"><p data-prose></p><details><summary>展开记录</summary><p>折叠内容。</p></details></div><div class="QQ_chat_msgdiv" data-game style="margin-top:18px;background:var(--app-surface-card);padding:18px;border-radius:16px"><iframe title="交互内容" srcdoc="<p>游戏前端实例</p><button onclick=\"window.clicks=(window.clicks||0)+1\">操作</button>" style="border:0;width:100%;height:90px"></iframe></div></div><div style="height:100px"></div></div><div class="chat-input-row" style="display:flex;padding:16px;gap:8px"><button class="voice-btn" type="button">+</button><div class="chat-action-inline"></div><textarea aria-label="草稿" style="flex:1;min-width:0"></textarea></div>';
  document.body.append(host);
  const root = host.querySelector('[data-scroll]'), input = host.querySelector('textarea'), wrapper = host.querySelector('[data-msg-id=format-latest]');
  wrapper.__chatappMessage = message; host.querySelector('[data-prose]').textContent = message.content;
  const frame = host.querySelector('iframe'), frameWindow = frame.contentWindow;
  const scriptRoot = document.querySelector('#chatapp-script-virtual-ui-root'), oldStyle = scriptRoot?.getAttribute('style');
  if (scriptRoot) scriptRoot.style.setProperty('display', 'none', 'important');
  const existingToasts = new Set(document.querySelectorAll('#toast-container>div'));
  const codeViewer = createCodeViewerUiRuntime({ documentLike: document, windowLike: window, schedule: setTimeout });
  let viewer = null, configDialog = null, editor = null, longTimer = null, longStart = null;
  const menu = document.createElement('div'); menu.style.display = 'none'; host.append(menu);
  const ui = { inputEl: input, scrollEl: root, contextMenu: menu,
    clearLongPress: () => { clearTimeout(longTimer); longTimer = null; longStart = null; },
    openFormatPatchReview: options => { const result = codeViewer.openPatchReview(viewer, options); viewer = result.overlay; return result.promise; },
    actionHandler: async (action, sourceMessage, payload) => {
      check(action === 'edit-assistant-raw' && payload.source === 'chat_format_guardian', 'ordinary format commit route');
      check(sourceMessage.id === message.id && payload.canCommit(), 'write identity');
      check(validateFormatRepairWriteScope(message.rawOriginal, payload.text, payload.formatSelection).ok, 'exact scoped write');
      commits.push(payload.text); message = { ...message, rawOriginal: payload.text }; wrapper.__chatappMessage = message; return true;
    } };
  const formatTarget = () => ({ ok: true, sourceText: message.rawOriginal, sourceKind: 'creative_raw_original', sourceSessionId: context.sessionId,
    targetSessionId: context.sessionId, sourceMessageIds: [message.id], turnId: 'smoke-turn' });
  const baseOptions = (_sid, config) => ({ surface: 'creative', uiMode: 'rp', modelReview: { enabled: true, agentConfig: config,
    surface: 'creative', uiMode: 'rp', formatTarget: 'creative_text', enabledFormats: { tableEdit: true },
    backgroundChat: async rows => {
      requests.push(rows); await pause(80);
      const baseRevision = /baseRevision: ([^\r\n]+)/.exec(rows.map(row => row.content).join('\n'))[1];
      return JSON.stringify({ protocolVersion: 'format_patch.v1', baseRevision, status: 'patch', repairSummary: '修正表格指令中的 JSON 逗号',
        linePatches: [{ startLine: 2, endLine: 2, originalLines: [table.split('\n')[1]], replacementLines: [table.split('\n')[1].replace(',}', '}')] }] });
    } } });
  const runtime = createAgentToolsAppRuntime({ ui, store, getContext: () => ({ ...context }), getMessages: () => [older, message], getRaw: async m => m.rawOriginal,
    getProfiles: () => [], getEvidence: () => [], captureModel: async () => ({}), request: () => { throw Error('unexpected request'); },
    getDisplaySource: m => m.content, getFormatTarget: async m => m.id === message.id ? formatTarget() : { ok: false },
    buildFormatOptions: baseOptions, getCurrentModelLabel: () => '测试模型', documentRef: document, storage,
    buildFormatPreview: options => buildFormatRepairRequest({ config: options.config, message, repairTarget: formatTarget(),
      range: options.targetSnapshot?.formatSelection?.fragment ? options.targetSnapshot.formatSelection : null, baseOptions: baseOptions(context.sessionId, options.config) }),
    openAgent: (id, options) => {
      editor?.dispose(); configDialog?.remove();
      configDialog = document.createElement('dialog'); configDialog.style.cssText = 'width:min(780px,calc(100vw - 32px));height:85dvh;overflow:auto;background:var(--app-surface-card);color:var(--app-text-primary);border:1px solid var(--app-border-default);border-radius:18px';
      editor = createAgentConfigurationEditor({ actions: runtime.actions, id, context, ...options }); configDialog.append(editor.node || editor.element);
      const close = document.createElement('button'); close.type = 'button'; close.dataset.closeConfig = ''; close.textContent = '关闭';
      close.addEventListener('click', () => { editor.dispose(); editor = null; configDialog.close(); configDialog.remove(); configDialog = null; }); configDialog.prepend(close); document.body.append(configDialog); configDialog.showModal();
    }, openCenter: () => {} });
  const selection = bindBubbleTextSelection({ ui, runtime: {}, toolbox: runtime.toolbox, canEdit: m => m?.role === 'assistant' });
  createLongPressUiRuntime().bindMessageContextInteractions({ wrapper, message, getLongPressTimer: () => longTimer, getLongPressStart: () => longStart,
    getPoint: event => ({ x: event.clientX, y: event.clientY }), clearLongPress: ui.clearLongPress,
    startLongPress: (event, msg) => createLongPressUiRuntime().startLongPress({ event, message: msg, getPoint: e => ({ x: e.clientX, y: e.clientY }), clearExisting: ui.clearLongPress,
      setLongPressStart: value => longStart = value, setLongPressTimer: value => longTimer = value, onTrigger: () => { menu.style.display = 'block'; } }) });
  const click = key => { const control = [...runtime.toolbox.panel.querySelectorAll('[data-key]')].find(node => node.dataset.key === key); check(control && !control.disabled, `click ${key}`); control.click(); };
  window.__formatToolsSmoke = { runtime, host, profileId, raw, table, requests, commits, click, pause, check, frameWindow,
    get message() { return message; }, get viewer() { return viewer; }, get editor() { return editor; },
    dispose: () => { selection.dispose(); runtime.dispose(); editor?.dispose(); configDialog?.remove(); viewer?.remove(); ui.clearLongPress(); host.remove();
      document.querySelectorAll('#toast-container>div').forEach(node => { if (!existingToasts.has(node)) node.remove(); });
      if (scriptRoot) oldStyle === null ? scriptRoot.removeAttribute('style') : scriptRoot.setAttribute('style', oldStyle); delete window.__formatToolsSmoke; } };
  runtime.toolbox.open(); return { profileId };
};

const page = await findAppPageTarget(), pending = new Map(); let socket, sequence = 0;
await new Promise((resolve, reject) => { socket = createWsClient(page.webSocketDebuggerUrl, { onOpen: resolve, onError: reject, onMessage: raw => {
  const data = JSON.parse(raw), job = pending.get(data.id); if (!job) return; pending.delete(data.id); data.error ? job.reject(Error(JSON.stringify(data.error))) : job.resolve(data.result);
} }); });
const command = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
const evaluate = body => evaluateInApp(`(async()=>{const f=window.__formatToolsSmoke;${body}})()`);
const mouse = async selector => {
  const p = await evaluateInApp(`(()=>{const b=document.querySelector(${JSON.stringify(selector)});b.scrollIntoView({block:'nearest'});const r=b.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2};})()`);
  await command('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1, ...p });
  await command('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', buttons: 0, clickCount: 1, ...p });
};
try {
  const { profileId } = await evaluateInApp(`(${setup.toString()})()`);
  await mouse('.agent-toolbox-panel:not([hidden]) [data-key="tool:reply_check"]');
  assert.equal(await evaluate(`return f.runtime.toolbox.panel.querySelector('.at-card').dataset.mode;`), 'profiles');
  await mouse(`.agent-toolbox-panel:not([hidden]) [data-key="repair:${profileId}"]`);
  await evaluate(`await f.pause();f.check(!f.runtime.toolbox.panel.querySelector('select[data-key=target]'),'no range dropdown');f.check(f.host.querySelectorAll('.fr-pickable').length===2,'latest reply bubbles marked');f.check(!f.host.querySelector('[data-msg-id=format-older] .fr-pickable'),'history excluded');f.check(f.host.querySelector('iframe').inert,'interactive frame shielded');`);
  await evaluate(`const prose=f.host.querySelector('[data-prose]');prose.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerType:'touch',clientX:80,clientY:130}));await f.pause(740);f.check(!f.host.lastElementChild||f.host.lastElementChild.style.display!=='block','format picking suppresses stationary long-press menu');prose.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerType:'touch'}));`);
  await mouse('[data-format-smoke] [data-game] .fr-pick-button');
  await evaluate(`await f.pause();f.check(f.runtime.toolbox.panel.querySelector('[data-key=execute]')&&!f.runtime.toolbox.panel.querySelector('[data-key=execute]').disabled,'whole source prepared');f.check(f.host.querySelectorAll('.fr-picked').length===2,'shared source marked');f.check(f.requests.length===0,'selection never requests');`);
  await mouse('.agent-toolbox-panel:not([hidden]) [data-key="repair-raw"]');
  await mouse('.fr-source [data-block="0"]');
  await evaluate(`const area=document.querySelector('.fr-source textarea');f.check(area.value.slice(area.selectionStart,area.selectionEnd)===f.table,'tag chip selects exact block');`);
  await evaluate('await f.pause(180);');
  await command('Page.captureScreenshot', { format: 'png' }).then(result => writeFileSync('scripts/dev/tmp/format-repair-source-desktop.png', Buffer.from(result.data, 'base64')));
  await mouse('.fr-source [data-key="use"]');
  await evaluate(`await f.pause();f.check(f.runtime.toolbox.panel.querySelector('.at-scope').textContent.includes('片段'),'fragment retained');f.click('config:reply_check');await f.pause();const name=document.querySelector('dialog[open] [name=repairProfileName]');f.check(name.value==='表格指令','configuration opens selected profile');name.focus();name.value='表格指令 A';name.dispatchEvent(new Event('input',{bubbles:true}));f.check(document.activeElement===name,'typing preserves focus');document.querySelector('dialog[open] [data-ac=save]').click();await f.pause(150);f.check(f.runtime.actions.getAgentConfiguration({id:'reply_check',repairProfileId:f.profileId}).config.repairProfileName==='表格指令 A','profile saved');document.querySelector('[data-close-config]').click();f.runtime.toolbox.open();await f.pause();f.check(f.runtime.toolbox.panel.querySelector('.at-scope').textContent.includes('片段'),'configuration return retains raw selection');`);
  await mouse('.agent-toolbox-panel:not([hidden]) [data-key="execute"]');
  await evaluate(`await f.pause(200);f.check(f.requests.length===1&&f.commits.length===0,'request produces candidate only');f.check(f.host.querySelector('iframe').contentWindow===f.frameWindow&&!f.host.querySelector('iframe').inert,'iframe restored without reload');const run=f.runtime.formatRuntime.list().at(-1);f.check(run.status==='ready','candidate ready');f.click('review:'+run.id);await f.pause();f.check(f.viewer.__chatappRefs.applyReviewBtn.disabled===false,'validated apply available');f.check(f.viewer.querySelector('.format-review-columns'),'paired review');f.check(f.viewer.__chatappRefs.panel.getBoundingClientRect().height<innerHeight*.84,'short review avoids full-height whitespace');`);
  await command('Page.captureScreenshot', { format: 'png' }).then(result => writeFileSync('scripts/dev/tmp/format-repair-review-desktop.png', Buffer.from(result.data, 'base64')));
  await evaluate(`f.viewer.__chatappRefs.applyReviewBtn.click();await f.pause();f.check(f.commits.length===1,'one commit');f.check(f.message.rawOriginal===f.raw.replace(',}', '}'),'only selected original changed');`);
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await evaluate(`f.runtime.toolbox.open();f.click('tool:reply_check');f.click('repair:'+f.profileId);f.host.querySelector('[data-game] .fr-pick-button').click();await f.pause();f.click('repair-raw');await f.pause();`);
  assert(await evaluate(`const r=document.querySelector('.fr-source').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1&&r.top>=0&&r.bottom<=innerHeight+1;`), 'source dialog fits mobile viewport');
  await command('Page.captureScreenshot', { format: 'png' }).then(result => writeFileSync('scripts/dev/tmp/format-repair-source-mobile.png', Buffer.from(result.data, 'base64')));
  await evaluate(`document.querySelector('.fr-source [data-key=close]').click();f.click('tool:reply_check');f.check(!f.host.querySelector('.fr-pickable')&&!f.host.querySelector('iframe').inert,'same icon exits selection');`);
  console.log('production format profiles, bubble/iframe selection, exact raw fragment, configuration return, candidate review/apply and mobile layout passed');
} finally {
  await command('Emulation.clearDeviceMetricsOverride').catch(() => {});
  await evaluateInApp('window.__formatToolsSmoke?.dispose()').catch(() => {}); socket?.close();
}
