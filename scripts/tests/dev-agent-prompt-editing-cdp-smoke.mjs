// Windows WebView smoke: production workspace + isolated in-memory save adapter.
// No user configuration, memory table, message or model request is written.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createWsClient, findAppPageTarget, evaluateInApp } from '../dev/cdp-client.mjs';

const target=await findAppPageTarget();let socket,sequence=0;const pending=new Map();
await new Promise((resolve,reject)=>{socket=createWsClient(target.webSocketDebuggerUrl,{onOpen:resolve,onError:reject,onMessage:raw=>{
  const message=JSON.parse(raw),task=pending.get(message.id);if(!task)return;pending.delete(message.id);clearTimeout(task.timer);
  if(message.error)task.reject(new Error(message.error.message));else task.resolve(message.result);
}});});
const command=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>reject(new Error(method)),20000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});
try {
  await command('Emulation.setFocusEmulationEnabled',{enabled:true});
  const result=await evaluateInApp(`(async()=>{
    for(let n=0;n<150 && !window.appBridge?.debugUiRegistry;n++)await new Promise(r=>setTimeout(r,100));
    window.appBridge.getScriptRuntime()?.uiShadow?.querySelector('.kmc-header button')?.click();
    const {mountAgentRequestPreview}=await import('/scripts/ui/chat/agent-request-preview.js');
    const {getAgentPromptFields}=await import('/scripts/ui/chat/agent-prompt-fields.js');
    const host=document.createElement('div');host.style.cssText='position:fixed;inset:20px;z-index:99999;background:var(--app-surface-card);color:var(--app-text-primary);padding:16px;box-sizing:border-box';
    host.innerHTML='<div class="agent-center-floating-card is-flipped" style="width:100%;max-width:none"><div class="agent-center-floating-inner"><div class="agent-center-floating-face agent-center-floating-face-back"><header>Prompt editing QA</header><label>Task<textarea name="prompt" aria-label="Task" style="width:100%;height:160px;box-sizing:border-box;padding:12px;font:13px/1.8 sans-serif">alpha\\nkeep\\nomega</textarea></label><label>Guide<textarea name="formatGuide" aria-label="Guide" style="width:100%;height:100px">saved guide</textarea></label></div></div></div>';
    document.body.append(host);
    const q={host,store:{prompt:'alpha\\nkeep\\nomega',formatGuide:'saved guide'},writes:[],builds:0,fail:false};window.__acDiffQa=q;
    q.wait=async predicate=>{for(let i=0;i<100;i++){if(predicate())return;await new Promise(r=>setTimeout(r,60));}throw new Error('Diff did not settle');};
    q.field=id=>host.querySelector('[name="'+id+'"]');
    q.edit=(id,value)=>{const el=q.field(id);el.value=value;el.dispatchEvent(new Event('input',{bubbles:true}));};
    q.action=(id,mode)=>[...host.querySelectorAll('.hop-request-editor [data-prompt-diff-action="'+mode+'"]')].find(el=>el.dataset.promptDiffField===id);
    q.preview=mountAgentRequestPreview({host,getFields:root=>getAgentPromptFields(root).map(field=>({...field,baseValue:q.store[field.id]})),
      buildRequest:async()=>{q.builds++;return {messages:[{role:'system',content:'External preset: readonly.'},{role:'system',content:q.field('prompt').value},{role:'system',content:q.field('formatGuide').value}],sections:[{}, {editField:'prompt'},{editField:'formatGuide'}]};},
      saveField:async({field,value,baseValue})=>{if(baseValue!==q.store[field.id])throw new Error('stale baseline');await new Promise(r=>setTimeout(r,100));if(q.fail)return {ok:false,message:'Fixture save failure'};q.store[field.id]=value;q.writes.push({id:field.id,value});return {ok:true,value};}});
    q.preview.open();await q.wait(()=>!host.querySelector('.hop-request-status').textContent);
    const first=host.querySelector('.hop-request-message');
    q.edit('formatGuide','unsaved guide');q.edit('prompt','ALPHA\\nkeep\\nOMEGA');
    await q.wait(()=>!host.querySelector('.hop-request-status').textContent);
    host.querySelector('[data-request-field="prompt"]').click();await new Promise(r=>setTimeout(r,180));
    const own=host.querySelector('.hop-request-output [data-prompt-field="prompt"]');
    const both=host.querySelector('.hop-request-editor .prompt-diff-review ins') && host.querySelector('.hop-request-field-editor .prompt-diff-review del') && own.querySelector('ins') && own.querySelector('del');
    q.action('prompt','accept').click();await q.wait(()=>q.writes.length===1);await new Promise(r=>setTimeout(r,50));
    const partial=q.store.prompt==='ALPHA\\nkeep\\nomega' && q.field('prompt').value==='ALPHA\\nkeep\\nOMEGA' && q.store.formatGuide==='saved guide' && q.field('formatGuide').value==='unsaved guide';
    q.action('prompt','reject').click();await q.wait(()=>!host.querySelector('.hop-request-status').textContent);
    const rejected=q.field('prompt').value===q.store.prompt && q.writes.length===1;
    q.edit('prompt','');await q.wait(()=>!!q.action('prompt','reject'));q.action('prompt','reject').click();
    const deletion=q.field('prompt').value===q.store.prompt;
    q.edit('prompt','failed draft');await q.wait(()=>!!q.action('prompt','accept'));q.fail=true;q.action('prompt','accept').click();
    await q.wait(()=>host.querySelector('.hop-request-edit-status').textContent==='Fixture save failure');
    const failure=q.writes.length===1 && q.field('prompt').value==='failed draft' && q.field('prompt').defaultValue===q.store.prompt;
    const stale=q.action('prompt','accept');q.edit('prompt','newer draft');stale.click();await new Promise(r=>setTimeout(r,180));
    const staleSafe=q.writes.length===1 && q.field('prompt').value==='newer draft';
    q.fail=false;q.edit('prompt',q.store.prompt);await q.wait(()=>!host.querySelector('.hop-request-status').textContent);
    const inline=host.querySelector('.hop-request-output [data-prompt-field="prompt"]');inline.scrollIntoView({block:'center'});inline.focus();
    const range=document.createRange();range.selectNodeContents(inline);range.collapse(false);document.getSelection().removeAllRanges();document.getSelection().addRange(range);q.inline=inline;
    return {both:!!both,partial,rejected,deletion,failure,staleSafe,externalReadonly:!first.querySelector('[contenteditable],[data-prompt-diff-action]'),retained:first===host.querySelector('.hop-request-message'),focused:document.activeElement===inline};
  })()`);
  assert.deepEqual(result,{both:true,partial:true,rejected:true,deletion:true,failure:true,staleSafe:true,externalReadonly:true,retained:true,focused:true});
  console.log('PASS both panes show diff; ✔ saves one hunk, × rejects one; deletion, failure, stale buttons and external boundaries are safe');
  await command('Input.imeSetComposition',{text:'中文输入',selectionStart:4,selectionEnd:4});
  assert.equal(await evaluateInApp('document.activeElement===window.__acDiffQa.inline'),true);
  await command('Input.insertText',{text:'中文完成'});
  const ime=await evaluateInApp(`(async()=>{const q=window.__acDiffQa;await new Promise(r=>setTimeout(r,700));const stable=document.activeElement===q.inline && q.inline.isConnected;const mirror=q.field('prompt').value.includes('中文完成');q.inline.blur();await new Promise(r=>setTimeout(r,100));return {stable,mirror,diff:!!q.host.querySelector('.hop-request-output [data-prompt-field="prompt"] ins'),saved:q.writes.length};})()`);
  assert.deepEqual(ime,{stable:true,mirror:true,diff:true,saved:1});
  console.log('PASS native IME edits the assembled own prompt; both drafts sync without replacing the focused node');
  assert.equal(await evaluateInApp(`(async()=>{const q=window.__acDiffQa,span=q.host.querySelector('.hop-request-output [data-prompt-field="prompt"]');span.click();span.blur();await new Promise(r=>setTimeout(r,100));return !!q.host.querySelector('.hop-request-output [data-prompt-field="prompt"] [data-prompt-diff-action]');})()`),true,'leaving inline edit without typing must restore its diff actions');
  writeFileSync('scripts/dev/tmp/ac-diff-desktop.png',Buffer.from((await command('Page.captureScreenshot',{format:'png'})).data,'base64'));
  await command('Emulation.setDeviceMetricsOverride',{width:390,height:820,deviceScaleFactor:1,mobile:true});
  const mobile=await evaluateInApp(`(async()=>{const q=window.__acDiffQa;await new Promise(r=>setTimeout(r,180));q.host.querySelector('[data-request-field="prompt"]').click();const area=q.host.querySelector('.hop-request-field-editor textarea');area.scrollIntoView({block:'start'});await new Promise(r=>setTimeout(r,160));const b=q.host.querySelector('.hop-request-field-editor [data-prompt-diff-action="reject"]');return {mode:q.host.querySelector('.hop-request-workspace').dataset.preview,overflow:q.host.scrollWidth>q.host.clientWidth,actions:!!b};})()`);
  assert.deepEqual(mobile,{mode:'full',overflow:false,actions:true});
  writeFileSync('scripts/dev/tmp/ac-diff-mobile.png',Buffer.from((await command('Page.captureScreenshot',{format:'png'})).data,'base64'));
  console.log('PASS mobile keeps editable source, diff actions and layout within the card');
} finally {
  await evaluateInApp('(() => {const q=window.__acDiffQa;q?.preview?.dispose();q?.host?.remove();delete window.__acDiffQa;return true;})()');
  await command('Emulation.clearDeviceMetricsOverride');await command('Emulation.setFocusEmulationEnabled',{enabled:false});socket.close();
}
