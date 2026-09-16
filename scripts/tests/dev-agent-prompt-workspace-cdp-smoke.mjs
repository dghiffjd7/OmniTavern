// Run against Windows dev. Edits only an unsaved AC prompt draft; no messages,
// model requests, template saves or memory row writes are performed.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createWsClient, findAppPageTarget, evaluateInApp } from '../dev/cdp-client.mjs';

const target = await findAppPageTarget();
let socket, sequence = 0;
const pending = new Map();
await new Promise((resolve,reject) => {
  socket = createWsClient(target.webSocketDebuggerUrl,{onOpen:resolve,onError:reject,onMessage:raw => {
    const message = JSON.parse(raw), task = pending.get(message.id); if (!task) return;
    pending.delete(message.id); clearTimeout(task.timer);
    if (message.error) task.reject(new Error(message.error.message)); else task.resolve(message.result);
  }});
});
const command = (method,params = {}) => new Promise((resolve,reject) => {
  const id = ++sequence, timer = setTimeout(() => { pending.delete(id);reject(new Error(`Timeout: ${method}`)); },20000);
  pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));
});
const screenshot = async name => writeFileSync(`scripts/dev/tmp/ac-prompt-${name}.png`,Buffer.from((await command('Page.captureScreenshot',{format:'png'})).data,'base64'));

try {
  await command('Emulation.setFocusEmulationEnabled',{enabled:true});
  const navigation = await evaluateInApp(`(async () => {
    const registry=window.appBridge.debugUiRegistry,panel=registry.panels.agentCenterPanel;
    window.appBridge.getScriptRuntime()?.uiShadow?.querySelector('.kmc-header button')?.click();
    panel.closeFloatingAgentCard({force:true});
    panel.show({tab:'agents',agentId:'memory_table_agent',configure:true});await panel.refresh();
    const root=panel.contentElement;
    root.querySelector('[data-agent-prompt-preview="memory_table_agent"]').click();
    for(let n=0;n<150 && root.querySelector('.hop-request-status').textContent;n++)await new Promise(r=>setTimeout(r,100));
    await new Promise(r=>setTimeout(r,200));
    const scroller=root.querySelector('.hop-request-scroll'),anchor=root.querySelector('[data-prompt-key="memory:data"]');
    const rect=anchor.getBoundingClientRect(),view=scroller.getBoundingClientRect();
    const request=panel.floatingPromptPreview.snapshot().request;
    window.__acNavigationQa={panel,root,at:request.at,messages:JSON.stringify(request.messages),first:root.querySelector('.hop-request-message')};
    panel.floatingPromptPreview.close();
    const field=root.querySelector('[data-memory-prompt-field="guide:output_instruction"]');
    field.closest('details').open=true;field.scrollIntoView({block:'center'});
    const fieldRect=field.getBoundingClientRect();
    return {visible:rect.top>=view.top-2 && rect.top<view.bottom,x:fieldRect.x+30,y:fieldRect.y+20};
  })()`);
  assert.equal(navigation.visible,true,'initial preview must open at table content beyond the long preset');
  const click = async (x,y) => {
    await command('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',clickCount:1});
    await command('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',clickCount:1});
  };
  await click(navigation.x,navigation.y);
  const guideOpen=await evaluateInApp(`(async()=>{
    const q=window.__acNavigationQa;q.panel.floatingPromptPreview.open();
    for(let n=0;n<150 && q.root.querySelector('.hop-request-status').textContent;n++)await new Promise(r=>setTimeout(r,100));
    await new Promise(r=>setTimeout(r,200));
    const scroller=q.root.querySelector('.hop-request-scroll'),anchor=q.root.querySelector('[data-prompt-key="field:memory:guide:output_instruction"]');
    const r=anchor.getBoundingClientRect(),s=scroller.getBoundingClientRect();
    q.at=q.panel.floatingPromptPreview.snapshot().request.at;
    const f=q.root.querySelector('[data-memory-prompt-field="guide:output_instruction"]').getBoundingClientRect(),e=q.root.querySelector('.hop-request-editor').getBoundingClientRect();
    return {key:q.root.querySelector('.hop-request-workspace').dataset.promptActive,visible:r.top>=s.top-2 && r.top<s.bottom,leftVisible:f.top<e.bottom && f.bottom>e.top,x:r.x+30,y:r.y+5};
  })()`);
  assert.equal(guideOpen.key,'field:memory:guide:output_instruction');assert.equal(guideOpen.visible,true);
  assert.equal(guideOpen.leftVisible,true,'splitting the pane must retain the originating field in the editor viewport');
  await click(guideOpen.x,guideOpen.y);
  const reverse=await evaluateInApp(`(async()=>{
    const q=window.__acNavigationQa;await new Promise(r=>setTimeout(r,120));
    const field=q.root.querySelector('[data-memory-prompt-field="guide:output_instruction"]'),editor=q.root.querySelector('.hop-request-editor');
    const r=field.getBoundingClientRect(),e=editor.getBoundingClientRect();
    return {linked:field.hasAttribute('data-preview-active'),visible:r.top>=e.top-2 && r.top<e.bottom,unchanged:q.at===q.panel.floatingPromptPreview.snapshot().request.at};
  })()`);
  assert.deepEqual(reverse,{linked:true,visible:true,unchanged:true});
  console.log('PASS real merged memory request opens at data/current guidance; native clicks link both panes without rebuilding');
  await command('Input.dispatchMouseEvent',{type:'mouseWheel',x:guideOpen.x,y:guideOpen.y+90,deltaY:300,deltaX:0});
  const scrolled=await evaluateInApp(`(async()=>{
    const q=window.__acNavigationQa;await new Promise(r=>setTimeout(r,180));
    const ws=q.root.querySelector('.hop-request-workspace'),editor=q.root.querySelector('.hop-request-editor'),field=editor.querySelector('[data-preview-active]');
    const r=field?.getBoundingClientRect(),e=editor.getBoundingClientRect();
    return {key:ws.dataset.promptActive,visible:!!r && r.top<e.bottom && r.bottom>e.top,unchanged:q.at===q.panel.floatingPromptPreview.snapshot().request.at,x:e.right-8,y:e.top+e.height/2};
  })()`);
  assert.notEqual(scrolled.key,guideOpen.key);assert.equal(scrolled.visible,true);assert.equal(scrolled.unchanged,true);
  await command('Input.dispatchMouseEvent',{type:'mouseWheel',x:scrolled.x,y:scrolled.y,deltaY:230,deltaX:0});
  const forwardScroll=await evaluateInApp(`(async()=>{
    const q=window.__acNavigationQa;await new Promise(r=>setTimeout(r,180));
    const anchor=q.root.querySelector('.hop-request-output [data-preview-active]'),view=q.root.querySelector('.hop-request-scroll').getBoundingClientRect(),r=anchor?.getBoundingClientRect();
    return {visible:!!r && r.top<view.bottom && r.bottom>view.top,unchanged:q.at===q.panel.floatingPromptPreview.snapshot().request.at};
  })()`);
  assert.deepEqual(forwardScroll,{visible:true,unchanged:true});
  console.log('PASS native wheel scrolling follows both ways without rebuilding the request');

  const opened = await evaluateInApp(`(async () => {
    const registry = window.appBridge.debugUiRegistry, panel = registry.panels.agentCenterPanel;
    panel.show({tab:'agents',agentId:'memory_table_agent',configure:true}); await panel.refresh();
    const root = panel.contentElement;
    const wait = async predicate => { for (let n=0;n<150;n++) { if (predicate()) return; await new Promise(r => setTimeout(r,100)); } throw new Error('Preview did not settle'); };
    root.querySelector('[data-agent-prompt-preview="memory_table_agent"]').click();
    await wait(() => !root.querySelector('.hop-request-status').textContent);
    const cfg = await registry.actions.getMemoryAgentPromptConfig();
    const select = root.querySelector('[data-request-field-select]'); select.value='memory:template';select.dispatchEvent(new Event('change',{bubbles:true}));
    const area = root.querySelector('.hop-request-field-editor textarea');
    const original = area.value;
    const first=root.querySelector('.hop-request-message');
    area.value='AC_WORKSPACE_MARKER{{setvar::ac_prompt_qa::draft_only}}\\n'+original;
    const store = registry.stores.chatStore, sid = store.getCurrent();
    window.__acPromptQa = {registry,panel,root,wait,cfg,area,original,sid,variables:JSON.stringify(store.listVariables(sid)),messages:JSON.stringify(store.getMessages(sid))};
    area.dispatchEvent(new Event('input',{bubbles:true}));
    await wait(() => !root.querySelector('.hop-request-status').textContent);
    const mirrored = root.querySelector('[data-memory-prompt-template]').value === area.value;
    const included = root.querySelector('.hop-request-output').textContent.includes('AC_WORKSPACE_MARKER');
    area.focus();area.setSelectionRange(0,0);
    return {mode:root.querySelector('.hop-request-workspace').dataset.preview,mirrored,included,retained:first===root.querySelector('.hop-request-message'),fields:root.querySelectorAll('[data-memory-prompt-field]').length,readonlyValues:root.querySelector('[data-agent-assembled-context]').querySelectorAll('textarea,input,[contenteditable="true"]').length};
  })()`);
  assert.equal(opened.mode,'split');assert.equal(opened.mirrored,true);assert.equal(opened.included,true);assert.equal(opened.readonlyValues,0);
  assert.equal(opened.retained,true,'editing a memory prompt must retain the unchanged preset message DOM');
  console.log('PASS real memory request includes the unsaved prompt draft; values remain read-only');

  await command('Input.imeSetComposition',{text:'输入中',selectionStart:3,selectionEnd:3});
  const retained = await evaluateInApp(`(async () => { const q=window.__acPromptQa; await q.panel.refresh();return document.activeElement === q.area && q.area.isConnected; })()`);
  assert.equal(retained,true,'refresh must retain the composing textarea');
  await command('Input.insertText',{text:'中文输入完成'});
  const editing = await evaluateInApp(`(async () => {
    const q=window.__acPromptQa;await q.wait(() => !q.root.querySelector('.hop-request-status').textContent);
    const now = await q.registry.actions.getMemoryAgentPromptConfig(), store=q.registry.stores.chatStore;
    return {focus:document.activeElement===q.area, mirrored:q.root.querySelector('[data-memory-prompt-template]').value===q.area.value,
      persisted:JSON.stringify(now)===JSON.stringify(q.cfg),variables:JSON.stringify(store.listVariables(q.sid))===q.variables,messages:JSON.stringify(store.getMessages(q.sid))===q.messages};
  })()`);
  assert.deepEqual(editing,{focus:true,mirrored:true,persisted:true,variables:true,messages:true});
  console.log('PASS native IME keeps focus through AC refresh; previews change no stored prompts, variables or messages');
  await screenshot('desktop-edit');

  const collapsed = await evaluateInApp(`(() => { const q=window.__acPromptQa;q.panel.closeTopLayer(); const handle=q.root.querySelector('.hop-request-open'),r=handle.getBoundingClientRect();return {state:q.root.querySelector('.hop-request-workspace').dataset.preview,x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
  assert.equal(collapsed.state,'closed');
  await command('Input.dispatchMouseEvent',{type:'mouseMoved',x:collapsed.x,y:collapsed.y});
  await command('Input.dispatchMouseEvent',{type:'mousePressed',x:collapsed.x,y:collapsed.y,button:'left',clickCount:1});
  await command('Input.dispatchMouseEvent',{type:'mouseMoved',x:collapsed.x-85,y:collapsed.y,button:'left',buttons:1});
  await command('Input.dispatchMouseEvent',{type:'mouseReleased',x:collapsed.x-85,y:collapsed.y,button:'left',clickCount:1});
  assert.equal(await evaluateInApp('window.__acPromptQa.root.querySelector(".hop-request-workspace").dataset.preview'),'split');
  console.log('PASS native pull gesture reopens the split preview');

  await command('Emulation.setDeviceMetricsOverride',{width:390,height:820,deviceScaleFactor:1,mobile:true});
  const phone = await evaluateInApp(`(async () => { const q=window.__acPromptQa;await new Promise(r=>setTimeout(r,200));const card=q.root.querySelector('.agent-center-floating-card');const anchor=q.root.querySelector('.hop-request-output [data-preview-active]'),a=anchor?.getBoundingClientRect(),v=q.root.querySelector('.hop-request-scroll').getBoundingClientRect();return {mode:q.root.querySelector('.hop-request-workspace').dataset.preview,width:card.getBoundingClientRect().width,viewport:innerWidth,editorInert:q.root.querySelector('.hop-request-editor').inert,linkedVisible:!!a && a.top<v.bottom && a.bottom>v.top};})()`);
  assert.equal(phone.mode,'full');assert.equal(phone.editorInert,true);assert(phone.width<=phone.viewport);
  assert.equal(phone.linkedVisible,true,'resizing to mobile must keep the linked prompt in view');
  await screenshot('mobile');
  await evaluateInApp('window.__acPromptQa.root.querySelector(".hop-request-return").click()');
  assert.equal(await evaluateInApp('window.__acPromptQa.root.querySelector(".hop-request-workspace").dataset.preview'),'closed');
  console.log('PASS mobile preview fills the card and the return handle restores editing');
} finally {
  await command('Emulation.setFocusEmulationEnabled',{enabled:false});
  await command('Emulation.clearDeviceMetricsOverride');
  await evaluateInApp(`(async () => { const q=window.__acPromptQa;if (!q) return;
    q.area.value=q.original;q.area.dispatchEvent(new Event('input',{bubbles:true}));q.panel.closeFloatingAgentCard({force:true});
    q.panel.show({tab:'agents',agentId:'memory_table_agent',configure:true});await q.panel.refresh();q.panel.contentElement.querySelector('[data-agent-prompt-preview="memory_table_agent"]').click();
    delete window.__acPromptQa;delete window.__acNavigationQa;
  })()`);
  socket.close();
}
