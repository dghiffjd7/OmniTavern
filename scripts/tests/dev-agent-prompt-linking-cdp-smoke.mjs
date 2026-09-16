// Windows dev: native scroll and selection checks; edits stay in the current draft.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createWsClient, findAppPageTarget, evaluateInApp } from '../dev/cdp-client.mjs';

const target=await findAppPageTarget();let socket,sequence=0;const pending=new Map();
await new Promise((resolve,reject)=>{socket=createWsClient(target.webSocketDebuggerUrl,{onOpen:resolve,onError:reject,onMessage:raw=>{
  const message=JSON.parse(raw),task=pending.get(message.id);if(!task)return;pending.delete(message.id);clearTimeout(task.timer);
  if(message.error)task.reject(new Error(message.error.message));else task.resolve(message.result);
}});});
const command=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>reject(new Error(method)),20000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const drag=async points=>{
 await command('Input.dispatchMouseEvent',{type:'mousePressed',x:points.x1,y:points.y1,button:'left',clickCount:1});
 for(let step=1;step<=4;step++)await command('Input.dispatchMouseEvent',{type:'mouseMoved',x:points.x1+(points.x2-points.x1)*step/4,y:points.y1+(points.y2-points.y1)*step/4,button:'left',buttons:1});
 await command('Input.dispatchMouseEvent',{type:'mouseReleased',x:points.x2,y:points.y2,button:'left',clickCount:1});
 await pause(180);
};
const screenshot=async name=>writeFileSync('scripts/dev/tmp/ac-selection-'+name+'.png',Buffer.from((await command('Page.captureScreenshot',{format:'png'})).data,'base64'));
try{
 await command('Emulation.setFocusEmulationEnabled',{enabled:true});
 const coords=await evaluateInApp(`(async()=>{
  const registry=window.appBridge.debugUiRegistry,panel=registry.panels.agentCenterPanel;
  window.appBridge.getScriptRuntime()?.uiShadow?.querySelector('.kmc-header button')?.click();
  panel.show({tab:'agents',agentId:'memory_table_agent',configure:true});await panel.refresh();
  const root=panel.contentElement,ws=root.querySelector('.hop-request-workspace'),left=ws.querySelector('.hop-request-editor'),right=ws.querySelector('.hop-request-scroll');
  const field=left.querySelector('[data-memory-prompt-field="guide:output_instruction"]');
  const q={registry,panel,root,ws,left,right,field,original:field.value,config:await registry.actions.getMemoryAgentPromptConfig()};window.__acLinkQa=q;
  q.wait=async()=>{for(let i=0;i<150 && root.querySelector('.hop-request-status').textContent;i++)await new Promise(r=>setTimeout(r,80));await new Promise(r=>setTimeout(r,180));};
  panel.floatingPromptPreview.close();const initial=left.querySelector('[data-memory-prompt-field="table:user_profile:column:notes"]') || field;
  initial.closest('details').open=true;initial.focus();panel.floatingPromptPreview.open();await q.wait();
  q.before={left:left.scrollTop,right:right.scrollTop,height:left.scrollHeight,opened:left.querySelectorAll('details[open]').length,source:ws.querySelector('.hop-request-field-editor textarea').value,at:panel.floatingPromptPreview.snapshot().request.at};
  q.moves=[];q.track=e=>{if(e.target===left)q.moves.push(left.scrollTop);};left.addEventListener('scroll',q.track);
  q.highlights=()=>[...(CSS.highlights.get('agent-prompt-linked-selection') || [])].map(range=>{const node=range.startContainer.parentElement,area=node.closest('.prompt-selection-layer')?.parentElement.querySelector('textarea');const review=node.closest('[data-prompt-review-field]'),r=range.getClientRects()[0],p=(left.contains(node)?left:right).getBoundingClientRect(),hit=r && document.elementFromPoint(r.left+1,r.top+r.height/2);return {kind:area?(area===ws.querySelector('.hop-request-field-editor textarea')?'source-area':'left-area'):review?(left.contains(review)?'left-review':'source-review'):left.contains(node)?'left-context':'request',text:range.toString(),key:node.closest('[data-prompt-key]')?.dataset.promptKey,visible:!!r && r.top>=p.top && r.bottom<=p.bottom && (area?hit===area:node.contains(hit))};});
  q.points=async node=>{node.scrollIntoView({block:node.getBoundingClientRect().height>right.clientHeight?'start':'center'});await new Promise(r=>setTimeout(r,100));const walker=document.createTreeWalker(node,4);let text;while((text=walker.nextNode()))if(text.length>12)break;if(!text)throw new Error('No selectable text');const offset=Math.max(0,text.data.search(/[^\\s]{12}/u));const a=document.createRange(),b=document.createRange();a.setStart(text,offset+1);a.setEnd(text,offset+2);b.setStart(text,offset+9);b.setEnd(text,offset+10);const x=a.getBoundingClientRect(),y=b.getBoundingClientRect();const points={x1:x.left+.5,y1:x.top+x.height/2,x2:y.left+.5,y2:y.top+y.height/2};if(!node.contains(document.elementFromPoint(points.x1,points.y1)))throw new Error('Selectable text is covered or off screen');return points;};
  const r=right.getBoundingClientRect();return {x:r.right-60,y:r.top+r.height*.5};
 })()`);
 await command('Input.dispatchMouseEvent',{type:'mouseWheel',...coords,deltaY:160,deltaX:0});await pause(320);
 const scroll=await evaluateInApp(`(()=>{const q=window.__acLinkQa;q.left.removeEventListener('scroll',q.track);return {moves:q.moves.length,height:q.left.scrollHeight===q.before.height,opened:q.left.querySelectorAll('details[open]').length===q.before.opened,source:q.ws.querySelector('.hop-request-field-editor textarea').value===q.before.source,request:q.panel.floatingPromptPreview.snapshot().request.at===q.before.at,key:q.ws.dataset.promptActive};})()`);
 assert(scroll.moves<=1);assert.equal(scroll.height,true);assert.equal(scroll.opened,true);assert.equal(scroll.source,true);assert.equal(scroll.request,true);assert.notEqual(scroll.key,'memory:guide');
 console.log('PASS one native wheel tick causes at most one follower scroll; no parent fallback, expansion, source switch or request rebuild');
 await evaluateInApp(`(()=>{const q=window.__acLinkQa;q.field.closest('details').open=true;q.field.scrollIntoView({block:'center'});q.field.focus();q.field.setSelectionRange(0,0);return true;})()`);
 for(let i=0;i<10;i++){
  await command('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39,modifiers:8});
  await command('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39,modifiers:8});
 }
 await pause(180);
 const keyboard=await evaluateInApp(`(()=>{const q=window.__acLinkQa;return {focus:document.activeElement===q.field,text:q.field.value.slice(q.field.selectionStart,q.field.selectionEnd),highlights:q.highlights()};})()`);
 assert.equal(keyboard.focus,true);assert.equal(keyboard.text.length,10);assert(keyboard.highlights.some(item=>item.kind==='request' && item.text===keyboard.text));
 await screenshot('keyboard');console.log('PASS native keyboard selection highlights matching request text without transferring focus');
 const rightPoints=await evaluateInApp(`window.__acLinkQa.points(window.__acLinkQa.ws.querySelector('.hop-request-output [data-prompt-field="memory:guide:output_instruction"]'))`);
 await drag(rightPoints);
 const reverse=await evaluateInApp(`(()=>{const q=window.__acLinkQa;return {text:getSelection().toString(),focus:!!document.activeElement.closest('.hop-request-output'),highlights:q.highlights()};})()`);
 assert(reverse.text.length>3);assert.equal(reverse.focus,true);assert(reverse.highlights.some(item=>item.kind==='left-area' && item.text===reverse.text));
 await screenshot('reverse');console.log('PASS native mouse selection in the request highlights the left textarea without stealing its caret');
 await evaluateInApp(`(async()=>{const q=window.__acLinkQa;getSelection().removeAllRanges();document.activeElement.blur();q.field.value='选区联动演示：'+q.original;q.field.dispatchEvent(new Event('input',{bubbles:true}));await q.wait();return true;})()`);
 const greenPoints=await evaluateInApp(`window.__acLinkQa.points(window.__acLinkQa.ws.querySelector('.hop-request-output [data-prompt-field="memory:guide:output_instruction"] .prompt-diff-add'))`);
 await drag(greenPoints);
 const green=await evaluateInApp(`(()=>{const q=window.__acLinkQa,node=q.ws.querySelector('.hop-request-output [data-prompt-field="memory:guide:output_instruction"]');return {text:getSelection().toString(),editing:node.isContentEditable,highlights:q.highlights()};})()`);
 assert(green.text.length>3);assert.equal(green.editing,false);assert(green.highlights.some(item=>item.kind==='left-area' && item.text===green.text));
 const redPoints=await evaluateInApp(`window.__acLinkQa.points(window.__acLinkQa.ws.querySelector('.hop-request-output [data-prompt-field="memory:guide:output_instruction"] .prompt-diff-del'))`);
 await drag(redPoints);
 const red=await evaluateInApp(`(()=>{const q=window.__acLinkQa;return {text:getSelection().toString(),highlights:q.highlights()};})()`);
 assert(red.text.length>3);assert(red.highlights.some(item=>item.kind==='left-review' && item.text===red.text && item.visible));assert(!red.highlights.some(item=>item.kind==='left-area'));
 await screenshot('diff');console.log('PASS dragging green/red diff text preserves the selection and maps to the live draft/old review respectively');
 await evaluateInApp(`(async()=>{const q=window.__acLinkQa;getSelection().removeAllRanges();q.field.value=q.original;q.field.dispatchEvent(new Event('input',{bubbles:true}));await q.wait();return true;})()`);
 const readonlyPoints=await evaluateInApp(`window.__acLinkQa.points(window.__acLinkQa.ws.querySelector('.hop-request-output [data-prompt-key="memory:data"]'))`);
 await drag(readonlyPoints);
 const readonly=await evaluateInApp(`(()=>{const q=window.__acLinkQa;return {text:getSelection().toString(),highlights:q.highlights(),writable:!!q.ws.querySelector('[data-prompt-key="memory:data"] [contenteditable]')};})()`);
 assert(readonly.text.length>3);assert.equal(readonly.writable,false);assert(readonly.highlights.some(item=>item.kind==='left-context' && item.text===readonly.text && item.visible));
 await screenshot('readonly');console.log('PASS selected table context mirrors to the left read-only assembly without granting edit access');
}finally{
 const result=await evaluateInApp(`(async()=>{const q=window.__acLinkQa;if(!q)return null;getSelection().removeAllRanges();q.left.removeEventListener('scroll',q.track);q.field.value=q.original;q.field.dispatchEvent(new Event('input',{bubbles:true}));await q.wait();const clean=JSON.stringify(await q.registry.actions.getMemoryAgentPromptConfig())===JSON.stringify(q.config);delete window.__acLinkQa;return clean;})()`);
 assert.equal(result,true,'stored template must remain unchanged');
 await command('Emulation.setFocusEmulationEnabled',{enabled:false});socket.close();
}
