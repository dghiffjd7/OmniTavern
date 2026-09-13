// Native keyboard and touch interaction with the production Agent editor and toolbox.
import assert from 'node:assert/strict';
import { evaluateInApp,createWsClient,findAppPageTarget } from '../dev/cdp-client.mjs';
const page=await findAppPageTarget();let client,seq=0;const pending=new Map();
await new Promise((resolve,reject)=>{client=createWsClient(page.webSocketDebuggerUrl,{onOpen:resolve,onError:reject,onMessage:raw=>{const m=JSON.parse(raw),j=pending.get(m.id);if(!j)return;pending.delete(m.id);m.error?j.reject(Error(JSON.stringify(m.error))):j.resolve(m.result);}});});
const command=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});client.send(JSON.stringify({id,method,params}));});
try {
 await evaluateInApp(`(async()=>{
 const {createAgentConfigurationEditor}=await import('/scripts/ui/agent-configuration-editor.js');
 const {createAgentToolsAppRuntime}=await import('/scripts/ui/agent-tools-app-runtime.js');
 const {createAgentConfigStore}=await import('/scripts/storage/agent-config-store.js');
 const context={sessionId:'rp:controls',scopeId:'controls',place:'writing',archiveId:'1'},memory=new Map(),storage={getItem:k=>memory.get(k),setItem:(k,v)=>memory.set(k,v)};
 const store=createAgentConfigStore({storage});
 const host=document.createElement('div');host.style.cssText='position:fixed;inset:12px;z-index:24000;background:var(--app-surface-card);padding:16px;overflow:auto';host.innerHTML='<div class="chat-input-row"><div class="chat-input-wrap"><textarea rows="2">短短的草稿</textarea></div></div><div data-editor></div>';document.body.append(host);
 const input=host.querySelector('textarea');let calls=0;
 const runtime=createAgentToolsAppRuntime({ui:{inputEl:input,openFormatPatchReview:async()=>({confirmed:false})},store,storage,getContext:()=>context,getMessages:()=>[],getRaw:async()=>'',getProfiles:()=>[{id:'mock',name:'模型'}],getEvidence:()=>[],captureModel:async()=>({}),request:async()=>{calls++;return '建议';},commitReply:async()=>false,openAgent:()=>{},openCenter:()=>{},runFormat:async()=>({status:'succeeded'}),buildFormatPreview:async()=>({messages:[]})});
 const made=await runtime.actions.createInputAgent();const rec=store.read(made.id,context);await runtime.actions.saveAgentConfiguration({...rec,config:{...rec.config,enabled:true,invocationMode:'both',modelMode:'profile',modelProfileId:'mock'}});
 const editor=createAgentConfigurationEditor({actions:runtime.actions,id:made.id,context});host.querySelector('[data-editor]').replaceWith(editor.node);
 const choose=()=>editor.node.querySelector('[name="invocationMode"]:checked');choose().focus();
 window.__agentControlSmoke={host,runtime,editor,id:made.id,store,context,get calls(){return calls;},choose,dispose(){editor.dispose();runtime.dispose();host.remove();delete window.__agentControlSmoke;}};
})()`);
 await command('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowLeft',code:'ArrowLeft',windowsVirtualKeyCode:37});
 await command('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowLeft',code:'ArrowLeft',windowsVirtualKeyCode:37});
 assert.equal(await evaluateInApp('window.__agentControlSmoke.choose().value'),'manual');
 await command('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39});
 await command('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39});
 assert.equal(await evaluateInApp('window.__agentControlSmoke.choose().value'),'both');
 await command('Emulation.setDeviceMetricsOverride',{width:390,height:820,deviceScaleFactor:1,mobile:true});
 await command('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1});
 const tap=async expression=>{const r=await evaluateInApp(`(()=>{const n=${expression};n.scrollIntoView({block:'center'});const r=n.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2};})()`);await command('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...r,radiusX:2,radiusY:2}]});await command('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});};
 await tap('window.__agentControlSmoke.editor.node.querySelector("[data-ac=toggle-enabled]")');
 assert.equal(await evaluateInApp('window.__agentControlSmoke.editor.node.querySelector("[data-ac=toggle-enabled]").getAttribute("aria-checked")'),'false');
 assert.equal(await evaluateInApp('window.__agentControlSmoke.choose().value'),'both');
 await tap('window.__agentControlSmoke.editor.node.querySelector("[name=invocationMode][value=manual]").parentElement');
 assert.equal(await evaluateInApp('window.__agentControlSmoke.choose().value'),'manual');
 // Close only the unsaved fixture editor, then touch the actual toolbox entry and tool.
 await evaluateInApp('(()=>{const f=window.__agentControlSmoke;f.editor.dispose();f.host.style.zIndex="22000";})()');
 await tap('window.__agentControlSmoke.runtime.toolbox.trigger');
 assert.equal(await evaluateInApp('window.__agentControlSmoke.runtime.toolbox.panel.hidden'),false);
 await tap('window.__agentControlSmoke.runtime.toolbox.panel.querySelector("[data-key^=run]")');
 await evaluateInApp('new Promise(r=>setTimeout(r,100))');
 assert.equal(await evaluateInApp('window.__agentControlSmoke.calls'),1);
 assert.equal(await evaluateInApp('window.__agentControlSmoke.runtime.inputAgents.list().at(-1).status'),'ready');
 console.log('ok - native radio keyboard navigation, touch master/mode, preserved mode and touch toolbox execution');
} finally {
 await command('Emulation.clearDeviceMetricsOverride');await command('Emulation.setTouchEmulationEnabled',{enabled:false});client.close();
 await evaluateInApp('window.__agentControlSmoke?.dispose()');
}
