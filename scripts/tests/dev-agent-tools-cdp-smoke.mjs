// Runs actual APP components in the Windows WebView with in-memory data and a fake model.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { evaluateInApp, createWsClient, findAppPageTarget } from '../dev/cdp-client.mjs';
const setup = async () => {
  const {createAgentToolsAppRuntime}=await import('/scripts/ui/agent-tools-app-runtime.js');
  const {createAgentConfigStore}=await import('/scripts/storage/agent-config-store.js');
  const {AgentCenterPanel}=await import('/scripts/ui/agent-center-panel.js');
  const {createScopedHopscotchBoardStore}=await import('/scripts/storage/hopscotch-board-store.js');
  const {createHopscotchTurnRuntime}=await import('/scripts/ui/chat/hopscotch-turn-runtime.js');
  const {createHopscotchBoardPanel}=await import('/scripts/ui/chat/hopscotch-board-panel.js');
  const {createCodeViewerUiRuntime}=await import('/scripts/ui/chat/code-viewer-ui-utils.js');
  const check=(condition,label)=>{if(!condition)throw Error(label);};
  const pause=(ms=100)=>new Promise(r=>setTimeout(r,ms));
  const memory=new Map(),storage={getItem:k=>memory.get(k),setItem:(k,v)=>memory.set(k,v)};
  let ctx={place:'writing',scopeId:'tools-smoke',sessionId:'rp:tools-smoke',archiveId:'1'},calls=0;
  const store=createAgentConfigStore({storage,onChange:()=>window.dispatchEvent(new CustomEvent('agent-feature-settings-changed'))});
  const host=document.createElement('div');host.style.cssText='position:fixed;z-index:21000;bottom:24px;left:20px;width:calc(100% - 40px);max-width:620px;padding:18px;border-radius:18px;background:var(--app-surface-card);box-shadow:0 8px 36px #0003';
  host.innerHTML='<div class="chat-input-row"><div class="chat-input-wrap"><textarea class="chat-input" aria-label="独立测试草稿" rows="3"></textarea></div></div>';document.body.append(host);
  const input=host.querySelector('textarea');input.value='旧句。';input.setSelectionRange(0,3);
  const messages=[{id:'reply',role:'assistant',type:'text',content:'旧句。'}];
  const viewer=createCodeViewerUiRuntime({documentLike:document,windowLike:window,schedule:fn=>setTimeout(fn,0)});let overlay=null,ac,board;
  const ui={inputEl:input,openFormatPatchReview:options=>{const r=viewer.openPatchReview(overlay,options);overlay=r.overlay;return r.promise;}};
  const runtime=createAgentToolsAppRuntime({ui,store,storage,getContext:()=>({...ctx}),getMessages:()=>messages,getRaw:async m=>m.content,
    getProfiles:()=>[{id:'mock',name:'轻量模型'}],getEvidence:()=>[],captureModel:async()=>({}),
    request:async req=>{calls++;if(req.baseRevision)return JSON.stringify({protocolVersion:'format_patch.v1',baseRevision:req.baseRevision,status:'patch',linePatches:[{startLine:1,endLine:1,originalLines:['旧句。'],replacementLines:['新句。']}],repairSummary:'调整措辞'});return '可以补充人物的动作与环境细节。';},
    commitReply:async()=>true,notifyReply:()=>{},runFormat:async()=>({status:'succeeded'}),buildFormatPreview:async()=>({messages:[]}),
    openAgent:(id,options)=>ac.show({agentId:id,configure:true,...options}),openCenter:()=>ac.show({tab:'agents'}),
  });
  ac=new AgentCenterPanel({getActions:()=>runtime.actions,getHopscotchPanel:()=>board});
  const boardStore=createScopedHopscotchBoardStore({storage,getSessionSettings:()=>({}),setSessionSettings:async()=>true});
  const workflow=createHopscotchTurnRuntime({boardStore});
  board=createHopscotchBoardPanel({embedded:true,boardStore,runtime:workflow,getSessionId:()=>ctx.sessionId,getPlace:()=>ctx.place,
    getInputSuggestion:()=>store.read('text_completion',ctx).config,getInputAgents:()=>store.list(ctx).filter(r=>r.config.kind==='input_agent').map(r=>r.config),
    createInputAgent:options=>runtime.actions.createInputAgent(options),openInputAgent:(id,options)=>{ac.openFloatingAgentCard(id,{...options,context:ctx});ac.toggleFloatingAgentCard();},
  });
  const fixture={ac,board,runtime,store,host,input,check,pause,get ctx(){return ctx;},get calls(){return calls;},get overlay(){return overlay;},
    dispose(){runtime.dispose();ac.destroy();board.dispose();host.remove();overlay?.remove();delete window.__agentToolsSmoke;}};
  window.__agentToolsSmoke?.dispose();window.__agentToolsSmoke=fixture;
  ac.show({tab:'agents'});await ac.refresh();
  const plus=ac.contentElement.querySelector('[data-hop-add-input]');check(plus,'input-row plus');plus.click();await pause();
  let editor=ac.contentElement.querySelector('.agent-config-editor');check(editor,'new input agent opens real card editor');
  fixture.id=editor.dataset.agentCommonEditor;
  check(store.read(fixture.id,ctx).config.enabled===false,'new input Agent starts disabled');
  const mode=value=>{editor.querySelector(`[name="invocationMode"][value="${value}"]`).click();editor=ac.contentElement.querySelector('.agent-config-editor');};
  mode('manual');check(!editor.querySelector('.ac-trigger'),'manual hides automatic timing');
  editor.querySelector('[data-ac="toggle-enabled"]').click();editor=ac.contentElement.querySelector('.agent-config-editor');
  check(editor.querySelector('[data-ac="toggle-enabled"]').classList.contains('is-on'),'master visually on');
  editor.querySelector('[data-ac="toggle-enabled"]').click();editor=ac.contentElement.querySelector('.agent-config-editor');
  check(editor.querySelector('[name="invocationMode"]:checked').value==='manual','master preserves mode');
  const model=editor.querySelector('[name="model"]');model.value='mock';model.dispatchEvent(new Event('change',{bubbles:true}));editor=ac.contentElement.querySelector('.agent-config-editor');
  editor.querySelector('[data-ac="toggle-enabled"]').click();editor=ac.contentElement.querySelector('.agent-config-editor');
  editor.querySelector('[data-ac="save"]').click();await pause();
  check(store.read(fixture.id,ctx).config.enabled && store.read(fixture.id,ctx).config.invocationMode==='manual','UI mode and master saved');
  check(calls===0,'configuration does not send model request');
  ac.closeFloatingAgentCard({force:true});await ac.refresh();
  const house=ac.contentElement.querySelector('[data-hop-input-agent]');check(house&&!house.classList.contains('is-disabled')&&house.textContent.includes('手动'),'manual house keeps color');
  ac.hide({force:true});runtime.toolbox.open();await pause();
  let p=runtime.toolbox.panel;check(p.querySelector('[data-key="run:'+fixture.id+'"]'),'manual agent in toolbox');
  p.querySelector('[data-key="run:'+fixture.id+'"]').click();await pause();
  check(calls===1&&p.textContent.includes('环境细节'),'note available in toolbox');check(input.value==='旧句。','note preserves draft');
  const note=runtime.inputAgents.list().at(-1);runtime.inputAgents.ignore(note.id);
  const saved=store.read(fixture.id,ctx);await runtime.actions.saveAgentConfiguration({...saved,config:{...saved.config,inputOutput:'rewrite'}});
  runtime.toolbox.open();p.querySelector('[data-key="run:'+fixture.id+'"]').click();await pause();
  p.querySelector('[data-key^="apply:"]').click();await pause();
  check(overlay&&overlay.style.display!=='none'&&p.hidden,'existing diff review opens above closed toolbox');
  check(input.value==='旧句。','review does not immediately modify draft');
  overlay.__chatappRefs.acceptAllBtn.click();await pause();overlay.__chatappRefs.applyReviewBtn.click();await pause();
  check(input.value==='新句。','confirmed patch writes only the draft');
  input.focus();check(document.execCommand('undo')&&input.value==='旧句。','draft apply supports native undo');runtime.inputAgents.pauseAutomatic();
  const latest=store.read(fixture.id,ctx);await runtime.actions.saveAgentConfiguration({...latest,config:{...latest.config,invocationMode:'auto',inputOutput:'note'}});
  input.focus();input.setSelectionRange(3,3);input.dispatchEvent(new Event('input',{bubbles:true}));for(let n=0;n<30&&runtime.inputAgents.list().at(-1)?.status!=='ready';n++)await pause();
  check(runtime.inputAgents.list().at(-1).status==='ready','custom automatic input task runs on pause: '+JSON.stringify({snapshot:runtime.inputAgents.snapshot(),jobs:runtime.inputAgents.list(),calls,active:document.activeElement?.outerHTML?.slice(0,200)}));
  runtime.toolbox.open();await pause();check(p.querySelector('[data-key^="result:"]'),'auto-only result has toolbox entry');check(!p.querySelector('[data-key^="run:"]'),'auto-only has no manual trigger');
  p.querySelector('[data-key^="result:"]').click();check(p.textContent.includes('环境细节'),'auto result can be read');
  ctx={...ctx,archiveId:'2'};window.dispatchEvent(new CustomEvent('session-changed'));await pause();check(p.hidden,'archive switch closes frozen toolbox');
  const before=store.read(fixture.id,ctx);await runtime.actions.saveAgentConfiguration({...before,config:{...before.config,invocationMode:'both'}});
  ac.show({agentId:fixture.id,configure:true});await pause();
  return {calls,master:true,modes:true,inputPlus:true,manualNotes:true,diff:true,nativeUndo:true,automaticResult:true,archiveGuard:true};
};
let client;const pending=new Map();let seq=0;
const page=await findAppPageTarget();
await new Promise((resolve,reject)=>{client=createWsClient(page.webSocketDebuggerUrl,{onOpen:resolve,onError:reject,onMessage:raw=>{const m=JSON.parse(raw),j=pending.get(m.id);if(!j)return;pending.delete(m.id);m.error?j.reject(Error(JSON.stringify(m.error))):j.resolve(m.result);}});});
const command=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});client.send(JSON.stringify({id,method,params}));});
try {
  console.log(await evaluateInApp(`(${setup.toString()})()`));
  const screenshot=async name=>{const r=await command('Page.captureScreenshot',{format:'png'});writeFileSync('scripts/dev/tmp/'+name+'.png',Buffer.from(r.data,'base64'));};
  await screenshot('agent-tools-desktop');
  for(const width of [390,320]) {
    await command('Emulation.setDeviceMetricsOverride',{width,height:820,deviceScaleFactor:1,mobile:true});
    await command('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1});
    const check=await evaluateInApp(`(async()=>{const f=window.__agentToolsSmoke;await f.pause();const r=f.ac.contentElement.querySelector('.ac-modes').getBoundingClientRect();return {left:r.left,right:r.right,width:innerWidth,segments:[...f.ac.contentElement.querySelectorAll('.ac-modes label')].map(n=>({height:n.getBoundingClientRect().height,clipped:n.scrollWidth>n.clientWidth+2}))};})()`);
    assert(check.left>=0&&check.right<=width+1);assert(check.segments.every(s=>s.height>=44&&!s.clipped));
    await screenshot('agent-tools-mobile-'+width);
    await evaluateInApp(`(()=>{window.__agentToolsSmoke.ac.hide({force:true});window.__agentToolsSmoke.runtime.toolbox.open();})()`);
    const bounds=await evaluateInApp(`(()=>{const r=window.__agentToolsSmoke.runtime.toolbox.panel.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom};})()`);
    assert(bounds.left>=0&&bounds.right<=width+1&&bounds.top>=0&&bounds.bottom<=820);
    await screenshot('agent-toolbox-mobile-'+width);
    await evaluateInApp(`(()=>{window.__agentToolsSmoke.runtime.toolbox.close();window.__agentToolsSmoke.ac.show({agentId:window.__agentToolsSmoke.id,configure:true});})()`);
    console.log({width,modeSegments:true,toolboxBounds:bounds});
  }
} finally {
  await command('Emulation.clearDeviceMetricsOverride');await command('Emulation.setTouchEmulationEnabled',{enabled:false});client.close();
  await evaluateInApp('window.__agentToolsSmoke?.dispose()');
}
