// Real toolbox/selection components with memory-only config, target and task ports.
// No user conversation/config writes and no remote model requests.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { evaluateInApp, createWsClient, findAppPageTarget } from '../dev/cdp-client.mjs';

const setup = async ({ settingsOnly = false } = {}) => {
  window.__toolboxEntrySmoke?.dispose();
  window.appBridge.debugUiRegistry.stores.agentToolsRuntime.toolbox.close();
  const { createAgentToolbox } = await import('/scripts/ui/agent-toolbox.js');
  const { bindBubbleTextSelection } = await import('/scripts/ui/chat/bubble-text-selection.js');
  const { createAgentConfigStore } = await import('/scripts/storage/agent-config-store.js');
  const { createAgentConfigurationService } = await import('/scripts/agent/agent-configuration-service.js');
  const { createRenderedAgentTargetResolver } = await import('/scripts/ui/chat/agent-rendered-body.js');
  const { createLongPressUiRuntime } = await import('/scripts/ui/chat/long-press-ui-utils.js');
  const { buildContextMenuActions } = await import('/scripts/ui/chat/context-menu-ui-utils.js');
  const { createAgentConfigurationEditor } = await import('/scripts/ui/agent-configuration-editor.js');
  const check = (ok, label) => { if (!ok) throw Error(label); };
  const pause = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));
  let context = { place: 'chat', scopeId: 'toolbox-smoke', sessionId: 'toolbox-smoke', archiveId: 'one' };
  const sourceText = '窗边的灯光照着摊开的书页，她抬起头，看见晚风拂过窗帘。桌上的热茶还冒着白汽。';
  const messages = [{ id: 'older', role: 'assistant', content: '较早的回复。', rawSource: '较早的回复。' },
    { id: 'latest', role: 'assistant', content: sourceText, rawSource: '<p>' + sourceText + '</p>', meta: { activeSwipe: 0 } }];
  const jobs = [], calls = [], configurations = [], memory = new Map();
  const existingToasts = new Set(document.querySelectorAll('#toast-container>div'));
  const scriptRoot = document.querySelector('#chatapp-script-virtual-ui-root');
  const scriptDisplay = scriptRoot?.style.getPropertyValue('display'), scriptDisplayPriority = scriptRoot?.style.getPropertyPriority('display');
  const savedFocus = document.activeElement, ranges = Array.from({length:getSelection().rangeCount}, (_, i) => getSelection().getRangeAt(i).cloneRange());
  const store = createAgentConfigStore({ storage: { getItem: () => null, setItem() {} } });
  await store.save({ id: 'text_completion', context, scope: 'global', config: { enabled: true, title: '输入建议', modelMode: 'profile', modelProfileId: 'mock', invocationMode: 'auto' } });
  await store.save({ id: 'reply_check', context, config: { enabled: true, modelMode: 'follow_current', invocationMode: 'both', title: '格式修复' } });
  await store.save({ id: 'text-edit:smoke', context, config: { enabled: true, modelMode: 'follow_current', invocationMode: 'manual', prompt: '优化选定正文', title: '正文优化', target: { mode: 'rendered' } } });
  await store.save({ id: 'input-agent:smoke', context, config: { enabled: true, modelMode: 'profile', modelProfileId: 'mock', invocationMode: 'manual', prompt: '给出建议', title: '草稿建议', inputOutput: 'note' } });
  const host = document.createElement('section'); host.dataset.toolboxSmoke = '';
  host.style.cssText = 'position:fixed;z-index:21500;inset:0;display:flex;flex-direction:column;background:var(--app-surface-page);color:var(--app-text-primary)';
  host.innerHTML = '<header style="padding:18px;border-bottom:1px solid var(--app-border-default)">Agent 工具箱 · 隔离验证</header><div class="at-fixture-scroll" style="flex:1;overflow:auto;padding:24px 20px"><div data-msg-id="latest" data-role="assistant" style="max-width:700px;margin:0 auto"><div class="QQ_chat_msgdiv" style="font-size:18px;line-height:2;white-space:pre-wrap;background:var(--app-surface-card);padding:16px;border-radius:16px"></div></div><div style="height:1100px"></div></div><div class="QQ_chat_page" style="height:auto;display:block;position:static;padding:12px"><div class="chat-input-row"><button class="voice-btn" type="button" aria-label="更多功能">+</button><div class="chat-action-inline" aria-hidden="true" inert></div><div class="chat-input-wrap"><textarea class="chat-input" aria-label="测试草稿">这是一段草稿。</textarea></div></div></div>';
  document.body.append(host);
  const input = host.querySelector('textarea'), plus = host.querySelector('.voice-btn'), inline = host.querySelector('.chat-action-inline'), page = host.querySelector('.QQ_chat_page');
  const scroll = host.querySelector('.at-fixture-scroll'), bubble = host.querySelector('.QQ_chat_msgdiv'), wrapper = bubble.parentElement;
  bubble.textContent = sourceText; wrapper.__chatappMessage = messages[1];
  const menu = document.createElement('div'); menu.style.display = 'none'; host.append(menu);
  input.setSelectionRange(2, 6);
  const snapshot = () => ({ text: input.value, start: input.selectionStart, end: input.selectionEnd, revision: 2, context: {...context} });
  const setExpanded = open => { page.classList.toggle('action-panel-open', open); inline.toggleAttribute('inert', !open); inline.setAttribute('aria-hidden', String(!open)); };
  plus.addEventListener('click', () => setExpanded(!page.classList.contains('action-panel-open')));
  let finish, rawLoads = 0;
  const service = createAgentConfigurationService({ store, getContext: () => ({...context}), getMessages: () => messages,
    getRaw: async message => { rawLoads++; return message.rawSource; }, getProfiles: () => [],
    resolveTarget: createRenderedAgentTargetResolver({ getDisplaySource: message => message.content, documentRef: document }),
    getFormatTarget: async message => message.id === 'latest' ? { ok: true, sourceText: '<MiPhone>' + sourceText + '</MiPhone>', sourceKind: 'social_turn_raw', sourceSessionId: context.sessionId, sourceMessageIds: ['latest', 'sibling'], turnId: 'turn1' } : { ok: false, reason: 'not_latest' },
    runtime: { list: () => jobs.filter(job => !job.id.startsWith('input-run')), run: async options => {
      calls.push(options);
      const job = { id: 'text-edit-run-' + calls.length, agentId: options.agentId, messageId: options.messageId, context: {...context}, title: '正文优化', status: 'running' };
      jobs.push(job); window.dispatchEvent(new Event('agent-text-edit-changed'));
      await new Promise(resolve => { finish = () => { job.status = 'ready'; job.message = '修改建议待查看'; resolve(); }; });
      return { status: 'succeeded', artifact: { runId: job.id } };
    }, cancel: id => { const job = jobs.find(job => job.id === id); if (job) { job.status = 'cancelled'; finish?.(); job.status = 'cancelled'; } },
    ignore: id => { jobs.find(job => job.id === id).status = 'ignored'; } },
  });
  let configured = '', managed = 0, manualEdits = 0;
  const actions = { ...service, listInputAgentRuns: () => jobs.filter(job => job.id.startsWith('input-run')),
    runConfiguredInputAgent: async options => { calls.push(options); return {status:'succeeded'}; },
    cancelInputAgentRun: id => { jobs.find(job => job.id === id).status = 'cancelled'; },
    saveAgentConfiguration: async options => { const result = await service.saveAgentConfiguration(options); if (result.ok) window.dispatchEvent(new Event('agent-feature-settings-changed')); return result; },
  };
  const toolbox = createAgentToolbox({ input, actions, getContext: () => ({...context}), getMessages: () => messages, getInputSnapshot: snapshot,
    triggerContainer: inline, anchorEl: plus, targetEventRoot: scroll, beforeOpen: () => setExpanded(false), openAgent: id => { configured = id; }, openCenter: () => { managed++; },
    storage: { getItem: key => memory.get(key) || (key.endsWith('v1') ? JSON.stringify({shortcut:{code:'KeyJ',ctrl:true,alt:true,meta:false,shift:false,label:'Ctrl + Alt + J'}}) : null), setItem: (key, value) => memory.set(key, value) } });
  const longPress = createLongPressUiRuntime(); let pressTimer, pressStart;
  const clearLongPress = () => longPress.clearLongPress({getLongPressTimer:()=>pressTimer,setLongPressTimer:value=>{pressTimer=value;},setLongPressStart:value=>{pressStart=value;}});
  const showMenu = event => { menu.textContent = buildContextMenuActions(messages[1]).map(action=>action.label).join(' · ');menu.style.cssText='position:fixed;z-index:22500;padding:12px;border-radius:12px;background:var(--app-surface-card);left:12px;top:'+Math.min(innerHeight-100,event.clientY+10)+'px'; };
  longPress.bindMessageContextInteractions({wrapper,message:messages[1],getLongPressTimer:()=>pressTimer,getLongPressStart:()=>pressStart,
    getPoint:event=>({x:event.clientX,y:event.clientY}),clearLongPress,showContextMenu:showMenu,startLongPress:(event,message)=>longPress.startLongPress({event,message,getPoint:event=>({x:event.clientX,y:event.clientY}),clearExisting:clearLongPress,setLongPressStart:value=>{pressStart=value;},setLongPressTimer:value=>{pressTimer=value;},onTrigger:showMenu})});
  const ui = { scrollEl: scroll, contextMenu: menu, clearLongPress, hideReactionPicker() {} };
  const selection = bindBubbleTextSelection({ ui, toolbox, runtime: { open: async () => { manualEdits++; return {text:'编辑',save:async()=>false}; } }, canEdit: () => true, onError: message => { throw Error(message); } });
  const click = key => { const button = [...toolbox.panel.querySelectorAll('[data-key]')].find(button => button.dataset.key === key && button.getClientRects().length); check(button, 'button exists: ' + key); button.click(); };
  const selectText = () => { const range = document.createRange(); range.setStart(bubble.firstChild, 0); range.setEnd(bubble.firstChild, 12); getSelection().removeAllRanges(); getSelection().addRange(range); };
  const fixture = { toolbox, host, input, plus, inline, scroll, bubble, menu, check, pause, click, selectText, calls, messages, jobs, context, store, memory, get rawLoads(){return rawLoads;},
    async extraTools() { for(let i=0;i<6;i++) await store.save({id:'text-edit:extra'+i,context,config:{enabled:true,title:'扩展工具 '+i,invocationMode:'auto',icon:i%2?'search':'book'}}); toolbox.refresh(); await pause(); },
    dispose() { clearLongPress(); selection.dispose(); toolbox.dispose(); host.remove();
      for (const toast of document.querySelectorAll('#toast-container>div')) if (!existingToasts.has(toast) && /当前会话的输入建议/.test(toast.textContent)) toast.remove();
      if (scriptRoot?.isConnected) { if (scriptDisplay) scriptRoot.style.setProperty('display', scriptDisplay, scriptDisplayPriority); else scriptRoot.style.removeProperty('display'); }
      getSelection().removeAllRanges(); for (const range of ranges) if(range.startContainer.isConnected) getSelection().addRange(range); savedFocus?.isConnected && savedFocus.focus({preventScroll:true}); delete window.__toolboxEntrySmoke; },
  };
  window.__toolboxEntrySmoke = fixture;
  scriptRoot?.style.setProperty('display', 'none', 'important');
  check(inline.contains(toolbox.trigger), 'entry stays inside +');
  plus.click(); toolbox.trigger.click(); await pause(180);
  check(!toolbox.panel.hidden && !page.classList.contains('action-panel-open'), 'open shelf closes +');
  const toggle = toolbox.panel.querySelector('[data-key="tool:text_completion"]');
  check(toggle && toggle.getAttribute('aria-pressed') === 'true', 'automatic input suggestion appears');
  click('tool:text_completion'); await pause();
  check(store.read('text_completion',context).config.enabled === false, 'toggle writes current room');
  check(toolbox.panel.querySelector('.at-notice').hidden, 'input toggle does not add a toolbox notice');
  check([...document.querySelectorAll('#toast-container.toast-top-right .toast-message')].some(node => node.textContent.includes('已关闭当前会话的输入建议')), 'input off uses the existing top-right notification');
  check(store.read('text_completion',context,'global').config.enabled === true, 'global default preserved');
  check(toolbox.panel.querySelector('[data-key="tool:text_completion"]') === toggle, 'off icon remains at same DOM identity');
  click('tool:text_completion'); await pause();
  check(toggle.getAttribute('aria-pressed') === 'true', 'same icon re-enables');
  check([...document.querySelectorAll('#toast-container.toast-top-right .toast-message')].some(node => node.textContent.includes('已开启当前会话的输入建议')), 'input on uses the same notification');
  click('tool:reply_check'); await pause();
  check(!calls.length && toolbox.panel.querySelector('[data-key=target]').value === 'latest', 'format opens latest target without requesting');
  check(toolbox.panel.querySelector('.at-scope').textContent.includes('2'), 'format card labels the full two-message turn');
  const targetSelect = toolbox.panel.querySelector('[data-key=target]');
  targetSelect.value='older'; targetSelect.dispatchEvent(new Event('change',{bubbles:true})); await pause();
  check(toolbox.panel.querySelector('[data-key=execute]').disabled, 'historical turn remains visibly unavailable');
  click('config:reply_check'); check(configured === 'reply_check' && toolbox.panel.hidden && !calls.length, 'config works without a valid target');
  toolbox.open(); await pause(); check(!toolbox.panel.querySelector('.at-card').hidden, 'return preserves selected tool');
  check(toolbox.panel.querySelector('.at-card').dataset.mode === 'task' && toolbox.panel.querySelector('[data-key=target]').value === 'older', 'task configuration preserves its chosen reply');
  toolbox.close(); toolbox.open(); click('manage');
  for (const id of ['reply_check', 'text_completion']) {
    const loads = rawLoads;
    click('config:' + id); check(configured === id && toolbox.panel.hidden, 'management opens the matching Agent config');
    toolbox.open(); await pause();
    check(toolbox.panel.querySelector('.at-card').dataset.mode === 'manage', 'management config returns to management, not a task');
    check(document.activeElement.dataset.key === 'config:' + id, 'return restores the matching management row');
    check(rawLoads === loads && !calls.length, 'returning from management does not prepare or invoke a task');
  }
  toolbox.close(); toolbox.open(); check(toolbox.panel.querySelector('.at-card').hidden, 'configuration return is consumed once');
  click('tool:reply_check'); await pause(); click('config:reply_check');
  toolbox.open({ messageId: 'latest' }); toolbox.close(); toolbox.open();
  check(toolbox.panel.querySelector('.at-card').hidden, 'explicit new target discards an old configuration return');
  if (settingsOnly) return { unifiedNotifications:true, managementReturn:true, taskReturn:true, noStaleReturn:true };
  toolbox.close(); toolbox.open(); click('tool:input-agent:smoke'); await pause(); click('execute'); await pause();
  check(calls.at(-1).inputTarget.start === 2 && calls.at(-1).inputTarget.end === 6, 'draft selection captured before blur');
  toolbox.close(); toolbox.open(); click('tool:text-edit:smoke'); await pause(); click('execute'); click('execute'); await pause();
  check(calls.filter(call=>call.agentId==='text-edit:smoke').length === 1, 'repeated execute cannot duplicate');
  const node = toolbox.panel.querySelector('[data-key=target]'), loads = rawLoads; node.focus();
  for (let i=0;i<10;i++) window.dispatchEvent(new Event('agent-text-edit-changed'));
  await pause();
  check(toolbox.panel.querySelector('[data-key=target]') === node && rawLoads === loads, 'status updates preserve target DOM and do not reload source');
  finish(); await pause();
  check(toolbox.panel.querySelector('[data-key^="review:"]'), 'editing result leads to existing review');
  click('ignore:'+jobs.at(-1).id); await pause();
  jobs.push({id:'input-run-note',agentId:'text_completion',title:'输入建议',kind:'suggestion',context:{...context},status:'ready',revision:2,start:2,end:6,text:'后续建议'});
  toolbox.refresh(); await pause(); click('runs'); click('result:input-run-note'); await pause();
  check(toolbox.panel.querySelector('[data-key="apply:input-run-note"]'), 'automatic input result stays accessible separately from the switch');
  jobs.length=0; toolbox.close(); toolbox.open(); click('tool:text-edit:smoke'); await pause();
  click('pick'); check(toolbox.panel.querySelector('.at-shelf').hidden,'tool-first selection collapses controls');
  fixture.selectText(); await pause(180);
  check(!document.querySelector('.bubble-selection-tools:not([hidden])')?.hidden,'selection can return to the tool');
  document.querySelector('.bubble-selection-tools:not([hidden])').click(); await pause(100);
  check(toolbox.panel.querySelector('.at-scope').textContent.includes('已选文字'), 'selection returns to same task with mapped range');
  check(toolbox.panel.querySelector('.at-target-excerpt').textContent === sourceText.slice(0,12),'target is selected text after focus loss');
  const branch = messages[1]; branch.meta.activeSwipe=1; bubble.append(document.createTextNode('')); await pause();
  check(toolbox.panel.querySelector('[data-key=execute]').disabled,'branch change expires the open target');
  branch.meta.activeSwipe=0; toolbox.close(); toolbox.open({keyboard:true});
  toolbox.back(); check(toolbox.panel.hidden && document.activeElement===plus,'back returns focus to visible +');
  document.dispatchEvent(new KeyboardEvent('keydown',{key:'j',code:'KeyJ',ctrlKey:true,altKey:true,bubbles:true}));
  check(!toolbox.panel.hidden, 'legacy shortcut migration');
  context = {...context,archiveId:'two'}; window.dispatchEvent(new Event('session-changed')); await pause();
  check(toolbox.panel.hidden, 'archive switch closes target');
  context = {...context,archiveId:'one'};
  const editor = createAgentConfigurationEditor({actions,id:'text-edit:smoke',context,documentRef:document});
  const editorNode = editor.element || editor.node;
  check(editorNode, 'configuration editor exposes its element');
  host.append(editorNode); editorNode.querySelector('[data-ac="icon:spark"]').click();
  check(editorNode.querySelector('[data-ac="icon:spark"]').getAttribute('aria-pressed')==='true','custom icon selection uses existing config draft');
  check(store.read('text-edit:smoke',context).config.icon==='','unsaved icon does not change stored config');
  editor.dispose(); editorNode.remove();
  return { toggles:true, formatTurn:true, config:true, draft:true, dedupe:true, stableDom:true, results:true, selection:true, branchGuard:true, shortcut:true, archiveGuard:true };
};

const page = await findAppPageTarget(), pending = new Map();
let socket, sequence = 0;
await new Promise((resolve,reject)=>{socket=createWsClient(page.webSocketDebuggerUrl,{onOpen:resolve,onError:reject,onMessage:raw=>{const data=JSON.parse(raw),job=pending.get(data.id);if(!job)return;pending.delete(data.id);data.error?job.reject(Error(JSON.stringify(data.error))):job.resolve(data.result);}});});
const command = (method,params={}) => new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});
const pause = ms => new Promise(resolve=>setTimeout(resolve,ms));
try {
  const settingsOnly = process.argv.includes('--settings-only');
  console.log(await evaluateInApp(`(${setup.toString()})(${JSON.stringify({ settingsOnly })})`));
  if (settingsOnly) {
    const click = async key => {
      const point = await evaluateInApp(`(()=>{const b=[...window.__toolboxEntrySmoke.toolbox.panel.querySelectorAll('[data-key]')].find(n=>n.dataset.key===${JSON.stringify(key)});b.scrollIntoView({block:'nearest'});const r=b.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2};})()`);
      await command('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',buttons:1,clickCount:1,...point});
      await command('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',buttons:0,clickCount:1,...point});
    };
    const key = async (key, code, modifiers = 0, windowsVirtualKeyCode = 0) => {
      await command('Input.dispatchKeyEvent',{type:'rawKeyDown',key,code,modifiers,windowsVirtualKeyCode});
      await command('Input.dispatchKeyEvent',{type:'keyUp',key,code,modifiers,windowsVirtualKeyCode});
    };
    await click('manage'); await click('shortcut');
    await key('k','KeyK',0,75);
    assert(await evaluateInApp(`(()=>{const f=window.__toolboxEntrySmoke;return f.toolbox.panel.querySelector('[data-key=shortcut]').getAttribute('aria-pressed')==='true'&&f.toolbox.panel.querySelector('.at-shortcut-hint').textContent.includes('再按另一个键')&&JSON.parse(f.memory.get('agent_toolbox_ui_v2')).shortcut.code==='KeyJ';})()`),'plain key gives feedback and preserves old binding');
    const image = await command('Page.captureScreenshot',{format:'png'}); writeFileSync('scripts/dev/tmp/toolbox-shortcut-feedback.png',Buffer.from(image.data,'base64'));
    await key('k','KeyK',3,75);
    assert(await evaluateInApp(`(()=>{const f=window.__toolboxEntrySmoke,s=JSON.parse(f.memory.get('agent_toolbox_ui_v2')).shortcut;return s.code==='KeyK'&&s.ctrl&&s.alt&&f.toolbox.panel.querySelector('kbd').textContent==='Ctrl + Alt + K';})()`),'native combination saves and displays binding');
    await command('Input.dispatchKeyEvent',{type:'rawKeyDown',key:'k',code:'KeyK',modifiers:3,windowsVirtualKeyCode:75,autoRepeat:true});
    assert(await evaluateInApp(`window.__toolboxEntrySmoke.toolbox.panel.querySelector('.at-card').dataset.mode==='manage'`),'held key does not reopen the toolbox');
    await click('shortcut'); await key('Escape','Escape',0,27);
    assert(await evaluateInApp(`(()=>{const f=window.__toolboxEntrySmoke;return f.toolbox.panel.querySelector('.at-card').dataset.mode==='manage'&&f.toolbox.panel.querySelector('[data-key=shortcut]').getAttribute('aria-pressed')==='false'&&JSON.parse(f.memory.get('agent_toolbox_ui_v2')).shortcut.code==='KeyK';})()`),'Escape cancels recording without discarding the saved shortcut');
    await evaluateInApp(`(()=>{const f=window.__toolboxEntrySmoke;f.toolbox.close();f.input.focus();f.draftBeforeShortcut=f.input.value;})()`);
    await key('k','KeyK',3,75);
    assert(await evaluateInApp(`(()=>{const f=window.__toolboxEntrySmoke;return !f.toolbox.panel.hidden&&f.toolbox.panel.querySelector('.at-card').hidden&&f.input.value===f.draftBeforeShortcut;})()`),'saved shortcut opens the shelf without changing the draft');
    await click('manage'); await click('clear-shortcut');
    await evaluateInApp('window.__toolboxEntrySmoke.toolbox.close()'); await key('k','KeyK',3,75);
    assert(await evaluateInApp('window.__toolboxEntrySmoke.toolbox.panel.hidden'),'cleared shortcut no longer opens the toolbox');
    console.log('native settings: single-key feedback, shortcut save/use/cancel/clear, and repeat guard passed');
  } else {
  await evaluateInApp('window.__toolboxEntrySmoke.extraTools()');
  for (const width of [390,320]) {
    await command('Emulation.setDeviceMetricsOverride',{width,height:820,deviceScaleFactor:1,mobile:true});
    await command('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1});
    console.log(await evaluateInApp(`(async()=>{const f=window.__toolboxEntrySmoke;f.toolbox.open();await f.pause(180);const shelf=f.toolbox.panel.querySelector('.at-shelf'),r=shelf.getBoundingClientRect();f.check(r.left>=0&&r.right<=innerWidth,'mobile shelf fits');f.check(!f.toolbox.panel.querySelector('[data-key=more]').hidden,'overflow explicit');f.check(!f.toolbox.panel.querySelector('[data-key=manage]').hidden,'gear always visible');for(const b of shelf.querySelectorAll('button'))if(b.getClientRects().length)f.check(b.getBoundingClientRect().width>=44,'44px touch target');f.click('more');await f.pause();f.check(f.toolbox.panel.querySelector('.at-overflow').innerText.includes('扩展工具'),'overflow has names');f.toolbox.back();f.click('tool:text-edit:smoke');await f.pause();const box=f.toolbox.panel.getBoundingClientRect();f.check(box.top>=0&&box.bottom<=innerHeight&&box.right<=innerWidth,'mobile task fits');return {width:innerWidth,shelf:true,overflow:true,card:true};})()`));
    const image=await command('Page.captureScreenshot',{format:'png'});writeFileSync(`scripts/dev/tmp/toolbox-mobile-${width}.png`,Buffer.from(image.data,'base64'));
  }
  await command('Emulation.clearDeviceMetricsOverride'); await command('Emulation.setTouchEmulationEnabled',{enabled:false});
  await evaluateInApp('window.__toolboxEntrySmoke.toolbox.close()');
  // Trusted desktop mouse drag, then the actual selection-tool button.
  const points=await evaluateInApp(`(()=>{const f=window.__toolboxEntrySmoke;f.scroll.scrollTop=0;const node=f.bubble.firstChild;const at=i=>{const r=document.createRange();r.setStart(node,i);r.setEnd(node,i+1);const b=r.getBoundingClientRect();return {x:b.left+1,y:b.top+b.height/2};};return {start:at(0),end:at(12)};})()`);
  await command('Emulation.setFocusEmulationEnabled',{enabled:true});
  await command('Input.dispatchMouseEvent',{type:'mouseMoved',...points.start});
  await command('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',buttons:1,clickCount:1,...points.start});
  await command('Input.dispatchMouseEvent',{type:'mouseMoved',button:'left',buttons:1,...points.end});
  await command('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',buttons:0,clickCount:1,...points.end});await pause(200);
  const tool=await evaluateInApp(`(()=>{const b=document.querySelector('.bubble-selection-tools:not([hidden])');if(!b)throw Error('trusted drag must expose toolbox');const r=b.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
  await command('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',buttons:1,clickCount:1,...tool});
  await command('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',buttons:0,clickCount:1,...tool});await pause(180);
  assert(await evaluateInApp('!window.__toolboxEntrySmoke.toolbox.panel.hidden'),'trusted selection click opens toolbox');
  await evaluateInApp('window.__toolboxEntrySmoke.click("tool:text-edit:smoke")');await pause(100);
  const image=await command('Page.captureScreenshot',{format:'png'});writeFileSync('scripts/dev/tmp/toolbox-desktop.png',Buffer.from(image.data,'base64'));
  console.log('trusted mouse selection passed');
  await command('Emulation.setDeviceMetricsOverride',{width:390,height:820,deviceScaleFactor:1,mobile:true});
  await command('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1});
  const mobilePoints = await evaluateInApp(`(()=>{const f=window.__toolboxEntrySmoke;f.toolbox.close();getSelection().removeAllRanges();f.scroll.scrollTop=0;const at=i=>{const r=document.createRange();r.setStart(f.bubble.firstChild,i);r.setEnd(f.bubble.firstChild,i+1);const b=r.getBoundingClientRect();return {x:b.left+2,y:b.top+b.height/2};};return {start:at(1),end:at(12)};})()`);
  const touch = (type,point) => command('Input.dispatchTouchEvent',{type,touchPoints:point?[{...point,id:1}]:[]});
  await touch('touchStart',mobilePoints.start);await pause(760);await touch('touchEnd');await pause(180);
  assert(await evaluateInApp('window.__toolboxEntrySmoke.menu.style.display !== "none"'),'stationary hold keeps the message menu');
  assert(await evaluateInApp('!window.__toolboxEntrySmoke.menu.textContent.includes("Agent 工具")'),'old menu item removed');
  await evaluateInApp('(()=>{window.__toolboxEntrySmoke.menu.style.display="none";getSelection().removeAllRanges();})()');
  await touch('touchStart',mobilePoints.start);await pause(460);await touch('touchMove',mobilePoints.end);await touch('touchEnd');await pause(220);
  assert(await evaluateInApp('window.__toolboxEntrySmoke.menu.style.display === "none" && getSelection().toString().length > 3'),'hold-drag selects without the message menu');
  const mobileTool = await evaluateInApp(`(()=>{const b=document.querySelector('.bubble-selection-tools:not([hidden])');if(!b)throw Error('hold-drag selection tool missing');const r=b.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
  await touch('touchStart',mobileTool);await touch('touchEnd');await pause(200);
  assert(await evaluateInApp('!window.__toolboxEntrySmoke.toolbox.panel.hidden'),'mobile selection tool opens the shelf');
  await evaluateInApp('window.__toolboxEntrySmoke.toolbox.close()');
  await touch('touchStart',mobilePoints.end);await pause(30);await touch('touchMove',{x:mobilePoints.end.x,y:mobilePoints.end.y-70});await touch('touchEnd');await pause(250);
  assert(await evaluateInApp('window.__toolboxEntrySmoke.scroll.scrollTop > 0 && window.__toolboxEntrySmoke.menu.style.display === "none"'),'ordinary swipe still scrolls');
  console.log('trusted touch: stationary menu, hold-drag selection, toolbox tap and reading scroll passed');
  }
} finally {
  await command('Emulation.clearDeviceMetricsOverride');await command('Emulation.setTouchEmulationEnabled',{enabled:false});await command('Emulation.setFocusEmulationEnabled',{enabled:false});socket.close();
  await evaluateInApp('window.__toolboxEntrySmoke?.dispose()');
}
