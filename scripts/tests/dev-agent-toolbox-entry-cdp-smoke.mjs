// Isolated composer fixture: no real Agent, model, storage, or conversation writes.
import assert from 'node:assert/strict';
import { evaluateInApp, createWsClient, findAppPageTarget } from '../dev/cdp-client.mjs';

const setup = async () => {
  const {createAgentToolbox}=await import('/scripts/ui/agent-toolbox.js');
  const check=(ok,label)=>{if(!ok)throw Error(label);};
  const pause=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
  let context={place:'writing',scopeId:'toolbox-entry-smoke',sessionId:'rp:toolbox-entry-smoke',archiveId:'1'};
  const messages=[{id:'older',role:'assistant',content:'较早回复'}, {id:'latest',role:'assistant',content:'最新回复'}];
  const configurations=[{id:'input-agent:smoke',kind:'input_agent',title:'草稿检查',enabled:true,invocationMode:'manual'}, {id:'text-edit:smoke',kind:'text_edit',title:'正文优化',enabled:true,invocationMode:'manual'}];
  const draft={text:'选中内容',start:1,end:5,revision:2};
  const jobs=[],calls=[];
  const host=document.createElement('section');host.className='QQ_chat_page';
  host.style.cssText='position:fixed;z-index:22000;inset:auto 10px 20px;width:calc(100% - 20px);height:auto;max-width:650px;padding:12px;background:var(--app-surface-card);border:1px solid var(--app-border-default);border-radius:18px';
  host.innerHTML='<div class="chat-input-row"><button type="button" class="voice-btn" aria-label="更多功能">+</button><div class="chat-action-inline" aria-hidden="true" inert><button type="button" class="chat-action-btn" data-action="generate-image" aria-label="生成图片"></button><button type="button" class="chat-action-btn" data-action="image" aria-label="发送图片"></button><button type="button" class="chat-action-btn" data-action="document" aria-label="发送附件"></button></div><div class="chat-input-wrap"><textarea class="chat-input" aria-label="独立入口测试草稿">已选中内容。</textarea></div></div>';
  document.body.append(host);
  const input=host.querySelector('textarea'),plus=host.querySelector('.voice-btn'),inline=host.querySelector('.chat-action-inline');
  input.setSelectionRange(1,5);
  const setExpanded=open=>{host.classList.toggle('action-panel-open',open);inline.toggleAttribute('inert',!open);inline.setAttribute('aria-hidden',String(!open));};
  plus.addEventListener('click',()=>setExpanded(!host.classList.contains('action-panel-open')));
  let managed=0;
  const toolbox=createAgentToolbox({input,triggerContainer:inline,anchorEl:plus,beforeOpen:()=>setExpanded(false),getContext:()=>({...context}),getMessages:()=>messages,getInputSnapshot:()=>({...draft}),openAgent:()=>{},openCenter:()=>managed++,
    storage:{getItem:()=>JSON.stringify({shortcut:{code:'KeyJ',ctrl:true,alt:true,meta:false,shift:false,label:'Ctrl + Alt + J'}}),setItem:()=>{}},
    actions:{listAgentConfigurations:()=>configurations.map(config=>({config})),listInputAgentRuns:()=>jobs,listTextEditRuns:()=>[],runConfiguredInputAgent:async options=>{calls.push(options);return {status:'succeeded'};},runTextEditAgent:async options=>{calls.push(options);return {status:'succeeded'};}},
  });
  const fixture={toolbox,host,plus,inline,input,check,pause,setExpanded,calls,dispose(){toolbox.dispose();host.remove();delete window.__toolboxEntrySmoke;}};
  window.__toolboxEntrySmoke?.dispose();window.__toolboxEntrySmoke=fixture;
  check(inline.contains(toolbox.trigger),'entry is inside plus actions');
  check(!host.querySelector('.chat-input-row > .agent-toolbox-trigger'),'no standalone toolbox');
  check(!toolbox.trigger.getClientRects().length,'entry hidden before plus');
  plus.click();check(toolbox.trigger.getClientRects().length,'plus reveals toolbox');
  toolbox.trigger.click();check(!toolbox.panel.hidden&&!host.classList.contains('action-panel-open'),'opening toolbox collapses plus actions');
  check(!inline.contains(document.activeElement),'focus leaves hidden actions');
  toolbox.panel.querySelector('[data-key="run:input-agent:smoke"]').click();await pause();
  check(calls.at(-1)?.inputTarget.start===1&&calls.at(-1)?.inputTarget.end===5,'selected draft target preserved');
  check(input.value==='已选中内容。','opening tools preserves draft');
  document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',bubbles:true}));
  check(toolbox.panel.hidden&&document.activeElement===plus,'Escape returns focus to visible plus');
  document.dispatchEvent(new KeyboardEvent('keydown',{key:'j',code:'KeyJ',ctrlKey:true,altKey:true,bubbles:true}));
  check(!toolbox.panel.hidden,'shortcut opens with plus collapsed');
  toolbox.close();toolbox.open({messageId:'older',selectedText:'较早'});
  check(toolbox.panel.querySelector('[data-key="target"]').value==='older','message entry preserves historical target');
  toolbox.panel.querySelector('[data-key="run:text-edit:smoke"]').click();await pause();
  check(calls.at(-1)?.messageId==='older'&&calls.at(-1)?.selectedText==='较早','message invocation preserves selected text');
  toolbox.close();jobs.push({id:'input-run-smoke',agentId:'input-agent:smoke',context:{...context},status:'ready',revision:2,start:1,end:5});
  toolbox.refresh();await pause();
  check(!plus.querySelector('.agent-toolbox-ready-dot').hidden&&toolbox.trigger.querySelector('small').textContent==='1','pending badge reaches plus and tool entry');
  jobs.length=0;configurations.length=0;toolbox.refresh();await pause();plus.click();toolbox.trigger.click();
  check(toolbox.panel.querySelector('[data-key="manage"]'),'empty tools retain management entry');
  toolbox.panel.querySelector('[data-key="manage"]').click();check(managed===1&&toolbox.panel.hidden,'management opens from empty toolbox');
  toolbox.open();context={...context,archiveId:'2'};window.dispatchEvent(new CustomEvent('session-changed'));await pause();
  check(toolbox.panel.hidden,'archive switch closes frozen target');
  return {plusEntry:true,hiddenFocus:true,draftSelection:true,messageTarget:true,shortcut:true,badges:true,emptyManagement:true,archiveGuard:true};
};
let client;const pending=new Map();let sequence=0;
const page=await findAppPageTarget();
await new Promise((resolve,reject)=>{client=createWsClient(page.webSocketDebuggerUrl,{onOpen:resolve,onError:reject,onMessage:raw=>{const data=JSON.parse(raw),job=pending.get(data.id);if(!job)return;pending.delete(data.id);data.error?job.reject(Error(JSON.stringify(data.error))):job.resolve(data.result);}});});
const command=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});client.send(JSON.stringify({id,method,params}));});
try {
  console.log(await evaluateInApp(`(${setup.toString()})()`));
  for(const width of [390,320]){
    await command('Emulation.setDeviceMetricsOverride',{width,height:820,deviceScaleFactor:1,mobile:true});
    await command('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1});
    const result=await evaluateInApp(`(async()=>{const f=window.__toolboxEntrySmoke;f.toolbox.close();f.setExpanded(true);await f.pause();const entry=f.toolbox.trigger.getBoundingClientRect(),input=f.input.getBoundingClientRect();f.toolbox.trigger.click();await f.pause();const panel=f.toolbox.panel.getBoundingClientRect();return {entry:{left:entry.left,right:entry.right,width:entry.width},input:{left:input.left,right:input.right,width:input.width},panel:{left:panel.left,right:panel.right,top:panel.top,bottom:panel.bottom},anchorVisible:!!f.plus.getClientRects().length};})()`);
    assert(result.entry.left>=0&&result.entry.right<=width&&result.entry.width>=32,'entry fits mobile action row');
    assert(result.input.right<=width&&result.input.width>60,'draft remains accessible');
    assert(result.anchorVisible&&result.panel.left>=0&&result.panel.right<=width&&result.panel.top>=0&&result.panel.bottom<=820,'panel fits and anchor stays visible');
    console.log({width,...result});
  }
} finally {
  await command('Emulation.clearDeviceMetricsOverride');await command('Emulation.setTouchEmulationEnabled',{enabled:false});client.close();
  await evaluateInApp('window.__toolboxEntrySmoke?.dispose()');
}
