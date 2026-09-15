// Windows dev WebView integration probe. Creates a dedicated preview conversation;
// only its synthetic messages are changed. No LLM request or gesture monkeypatch.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createWsClient, findAppPageTarget } from '../dev/cdp-client.mjs';

const output='scripts/dev/tmp/bubble-selection-live'; mkdirSync(output,{recursive:true});
const page=await findAppPageTarget(),pending=new Map();let client,sequence=0;
await new Promise((resolve,reject)=>{client=createWsClient(page.webSocketDebuggerUrl,{onOpen:resolve,onError:reject,onMessage:raw=>{
  const message=JSON.parse(raw),entry=pending.get(message.id);if(!entry)return;pending.delete(message.id);clearTimeout(entry.timer);
  message.error?entry.reject(Error(JSON.stringify(message.error))):entry.resolve(message.result);
}});});
const command=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>reject(Error('CDP timeout: '+method)),25000);
  pending.set(id,{resolve,reject,timer});client.send(JSON.stringify({id,method,params}));});
const evaluate=async expression=>{const result=await command('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
  if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);return result.result?.value;};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const until=async(expression)=>{for(let i=0;i<80;i++){try{if(await evaluate(expression))return;}catch{}await pause(150);}throw Error('Condition timed out: '+expression);};
const screenshot=async name=>{const {data}=await command('Page.captureScreenshot',{format:'png'});writeFileSync(`${output}/${name}.png`,Buffer.from(data,'base64'));};
const mouse=(type,point)=>command('Input.dispatchMouseEvent',{type,...point,button:'left',buttons:type==='mouseReleased'?0:1,clickCount:1});
const touch=(type,point)=>command('Input.dispatchTouchEvent',{type,touchPoints:point?[{...point,id:1}]:[]});
const click=async(selector,isTouch=false)=>{const point=await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing click target');const r=e.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2};})()`);
  if(isTouch){await touch('touchStart',point);await touch('touchEnd');}else{await mouse('mousePressed',point);await mouse('mouseReleased',point);}await pause(180);};
const editText=async text=>{await evaluate('document.querySelector(".text-fragment-editor textarea").focus();document.querySelector(".text-fragment-editor textarea").select()');await command('Input.insertText',{text});};
const phrase='窗边的灯光照着摊开的书页，她抬起头，看见晚风拂过窗帘。';
const replacement='暖黄的灯光落在书页上，她抬眼望向窗外，晚风正轻轻掀动窗帘。';
let session;
const read=()=>evaluate(`(()=>{const s=window.appBridge.getChatStore(),sid=${JSON.stringify(session.sid)};return{a:s.findMessage('selection-preview-a',sid),u:s.findMessage('selection-preview-u',sid),envelope:s.getLastRawResponseEnvelope(sid),menu:window.appBridge.getChatUI().contextMenu.style.display!=='none',selected:getSelection().toString(),editor:!!document.querySelector('.text-fragment-editor[open]'),scroll:window.appBridge.getChatUI().scrollEl.scrollTop};})()`);
const points=async(mid,text)=>{
  await until(`!!document.querySelector('[data-msg-id="'+${JSON.stringify(mid)}+'"][data-role] .QQ_chat_msgdiv') && !document.getElementById('app-splash')`);
  await evaluate(`(()=>{const ui=window.appBridge.getChatUI();ui.clearLongPress();ui.contextMenu.style.display='none';getSelection().removeAllRanges();document.querySelector('[data-msg-id="'+${JSON.stringify(mid)}+'"]').scrollIntoView({block:'center'});})()`);await pause(300);
  return evaluate(`(()=>{const b=document.querySelector('[data-msg-id="'+${JSON.stringify(mid)}+'"] .QQ_chat_msgdiv'),w=document.createTreeWalker(b,NodeFilter.SHOW_TEXT),entries=[];let n,all='';while(n=w.nextNode()){entries.push({node:n,start:all.length});all+=n.textContent;}const text=${JSON.stringify(text)},at=all.indexOf(text);if(at<0)throw Error('Text not visible: '+text);const locate=o=>{const e=entries.find(e=>o<e.start+e.node.length)||entries.at(-1);return[e.node,o-e.start];};const a=document.createRange(),z=document.createRange();a.setStart(...locate(at));a.collapse(true);z.setStart(...locate(at+text.length));z.collapse(true);const p=a.getBoundingClientRect(),q=z.getBoundingClientRect();return{start:{x:p.left+.8,y:p.top+p.height/2},end:{x:q.left-.8,y:q.top+q.height/2}};})()`);
};
const selectMouse=async(mid,text)=>{const p=await points(mid,text);await mouse('mousePressed',p.start);await mouse('mouseMoved',p.end);await mouse('mouseReleased',p.end);await pause(220);return p;};
const openEditor=async(isTouch=false)=>{await until('!!document.querySelector(".bubble-selection-edit:not([hidden])")');await click('.bubble-selection-edit',isTouch);await until('!!document.querySelector(".text-fragment-editor[open]")');};
const phase=process.argv.find(arg=>arg.startsWith('--phase='))?.split('=')[1]||'all';
const reports=[];
await pause(1800);
await until('!!window.appBridge?.getChatUI?.() && !!window.appBridge?.debugUiRegistry?.actions?.enterChatRoom && !!document.querySelector(".bubble-selection-edit") && !document.getElementById("app-splash")');
const initial=await evaluate('({width:innerWidth,height:innerHeight,deviceScaleFactor:devicePixelRatio})');
try {
  await command('Page.bringToFront');
  if(['all','setup'].includes(phase)){
    const ready=await evaluate('({busy:!!(window.appBridge.getChatUI().isStreaming||window.appBridge.getChatUI().isSending),draft:window.appBridge.getChatUI().inputEl.value,mode:document.body.dataset.uiMode})');
    assert.equal(ready.busy,false,'do not interrupt an active reply');assert.equal(ready.draft,'','do not discard a composer draft');
    if(ready.mode==='rp'){await click('#mode-switch button');await until('document.body.dataset.uiMode==="chat"');}
    const seed=`selection-preview-${Date.now()}`;
    session=await evaluate(`(async()=>{const b=window.appBridge,s=b.getChatStore(),r=b.debugUiRegistry,sid=${JSON.stringify(seed)};
      r.stores.contactsStore.upsertContact({id:sid,name:'选区编辑体验',description:'本地编辑示例，不会自动调用模型。'});
      const body=${JSON.stringify(phrase)}+'桌上的热茶还冒着白汽，走廊里传来很轻的脚步声。\\n\\n夜色渐深，她把书签夹在这一页，起身关上窗户。明天还有许多事情要做，今晚却可以先安静地休息一会儿。';
      const raw='<think>这段隐藏内容必须保留。</think>\\r\\n\\r\\n'+body.replace(/\\n/g,'\\r\\n')+'\\r\\n<tableEdit>保留表格指令</tableEdit>';
      const tail='这里可以试试选中一句话后编辑。电脑版直接拖选；手机按住后滑动选字，按住不动仍显示消息菜单。\\n\\n'+Array.from({length:10},(_,i)=>'阅读段落 '+(i+1)+'：窗外的夜色渐渐深了，书页翻过一页，杯里的茶还温着。').join('\\n\\n');
      const turnId=sid+'-turn',meta={formatRepairTurn:{sourceKind:'social_turn_raw',sourceSessionId:sid,turnId,sourceMessageIds:['selection-preview-a','selection-preview-tail']}};
      s.appendMessage({id:'selection-preview-u',role:'user',type:'text',status:'sent',rawInput:'这是自己的文字消息，也可以选中其中一部分修改。',raw:'这是自己的文字消息，也可以选中其中一部分修改。',content:'这是自己的文字消息，也可以选中其中一部分修改。'},sid);
      s.appendMessage({id:'selection-preview-a',role:'assistant',type:'text',status:'sent',name:'选区编辑体验',rawOriginal:raw,rawSource:body,raw:body,content:body,meta:{...meta,activeSwipe:1,swipes:[{rawOriginal:'这是另一条回复分支，保持原样。',raw:'这是另一条回复分支，保持原样。',content:'这是另一条回复分支，保持原样。'},{rawOriginal:raw,rawSource:body,raw:body,content:body}]}},sid);
      s.appendMessage({id:'selection-preview-tail',role:'assistant',type:'text',status:'sent',name:'选区编辑体验',raw:tail,rawSource:tail,content:tail,meta},sid);
      const envelope='<msg_start>选区编辑体验|12:00\\n'+raw+'\\n<msg_end>\\n<msg_start>选区编辑体验|12:01\\n'+tail+'\\n<msg_end>';
      s.setLastRawResponse(envelope,sid,{turnId,sourceSessionId:sid,targetSessionId:sid});for(const messageId of meta.formatRepairTurn.sourceMessageIds)s.registerLastRawResponseSourceMessage({sourceSessionId:sid,targetSessionId:sid,turnId,messageId});
      await s.flush();await r.actions.enterChatRoom(sid,'选区编辑体验','chat');return{sid,body,raw,envelope};})()`);
    writeFileSync(`${output}/session.json`,JSON.stringify(session,null,2));await pause(700);
    await screenshot('real-chat-before');reports.push('dedicated preview conversation created');
  }else{
    session=JSON.parse(readFileSync(`${output}/session.json`,'utf8'));
    await evaluate(`window.appBridge.debugUiRegistry.actions.enterChatRoom(${JSON.stringify(session.sid)},'选区编辑体验','chat')`);await pause(600);
  }
  if(['all','desktop','desktop-rest','desktop-finish'].includes(phase)){
    const before=await read();
    if(!['desktop-rest','desktop-finish'].includes(phase)){
      await selectMouse('selection-preview-a',phrase);assert.equal((await read()).selected,phrase);assert.equal((await read()).menu,false);
      await screenshot('desktop-selection');await openEditor();
      assert.equal(await evaluate('document.querySelector(".fragment-save").disabled'),true);
      await editText(replacement);await click('.text-fragment-editor summary');await screenshot('desktop-editor');await click('.fragment-save');await until('!document.querySelector(".text-fragment-editor[open]")');
    }else if(phase==='desktop-rest'){
      await selectMouse('selection-preview-a',replacement);await openEditor();
      assert.equal(await evaluate('document.querySelector(".fragment-count").textContent'),replacement.length+' 字');
      await click('.text-fragment-editor summary');await screenshot('desktop-editor');await click('.fragment-cancel');
    }
    const saved=await read();
    assert.equal(saved.a.rawOriginal??saved.a.meta.swipes[1].rawOriginal,session.raw.replace(phrase,replacement));assert.equal(saved.a.rawSource,session.body.replace(phrase,replacement));
    assert.deepEqual(saved.a.meta.swipes[0],before.a.meta.swipes[0]);assert.equal(saved.a.meta.swipes[1].rawOriginal,session.raw.replace(phrase,replacement));
    assert.equal(saved.envelope.text,session.envelope.replace(phrase,replacement));
    const pencil=await evaluate(`(async()=>{const ui=window.appBridge.getChatUI(),m=window.appBridge.getChatStore().findMessage('selection-preview-a',${JSON.stringify(session.sid)});await ui.actionHandler('view-code',m);const text=ui.__chatappCodeViewer.querySelector('textarea').value;ui.closeCodeViewer();return text;})()`);
    assert.equal(pencil,saved.envelope.text.replace(/\r\n?/g,'\n'));reports.push('desktop exact local save, current branch, and full pencil original synchronized');
    await selectMouse('selection-preview-u','自己的文字消息');await openEditor();await editText('我修改后的消息');await click('.fragment-save');await until('!document.querySelector(".text-fragment-editor[open]")');
    assert.equal((await read()).u.rawInput,before.u.rawInput.replace('自己的文字消息','我修改后的消息'));reports.push('user message raw input synchronized');
    await selectMouse('selection-preview-a',replacement);await openEditor();await editText('取消的草稿');
    assert.equal(await evaluate('window.appBridge.debugUiRegistry.actions.closeTopAppLayer()'),true);await until('!document.querySelector(".text-fragment-editor[open]")');
    assert.equal((await read()).a.meta.swipes[1].rawOriginal,saved.a.meta.swipes[1].rawOriginal);reports.push('app back closes editor without saving its draft');
    await evaluate('window.appBridge.getChatStore().flush()');
    writeFileSync(`${output}/persisted.json`,JSON.stringify(await read(),null,2));
  }
  if(['all','reload'].includes(phase)){
    const expected=JSON.parse(readFileSync(`${output}/persisted.json`,'utf8'));
    await command('Page.reload');await pause(800);
    await until('!!window.appBridge?.debugUiRegistry?.actions?.enterChatRoom && !!document.querySelector(".bubble-selection-edit") && !document.getElementById("app-splash")');
    await evaluate(`window.appBridge.debugUiRegistry.actions.enterChatRoom(${JSON.stringify(session.sid)},'选区编辑体验','chat')`);await pause(500);
    const restored=await read();assert.equal(restored.a.raw,expected.a.raw);assert.equal(restored.a.meta.swipes[1].rawOriginal,expected.a.meta.swipes[1].rawOriginal);assert.equal(restored.envelope.text,expected.envelope.text);assert.equal(restored.u.rawInput,expected.u.rawInput);
    reports.push('real store survives WebView reload and history restoration');
  }
  if(phase==='menu-trace'){
    await command('Emulation.setDeviceMetricsOverride',{width:390,height:780,deviceScaleFactor:1,mobile:true});await pause(300);
    const p=await points('selection-preview-a','暖黄的灯光落在书页上，她抬眼望向窗外。');
    await evaluate(`(()=>{const ui=window.appBridge.getChatUI(),events=[],start=performance.now(),types=['pointerdown','pointerup','touchstart','touchend','mousedown','mouseup','click','contextmenu','selectionchange'];const log=e=>events.push({type:e.type,ms:Math.round(performance.now()-start),target:e.target.closest?.('[data-msg-id][data-role]')?.dataset.msgId,menu:ui.contextMenu.style.display,selected:getSelection().toString().length});types.forEach(type=>document.addEventListener(type,log,true));const observer=new MutationObserver(()=>events.push({type:'menu-style',ms:Math.round(performance.now()-start),display:ui.contextMenu.style.display}));observer.observe(ui.contextMenu,{attributes:true,attributeFilter:['style']});window.__selectionMenuTrace={events,dispose:()=>{types.forEach(type=>document.removeEventListener(type,log,true));observer.disconnect();}};})()`);
    await touch('touchStart',p.start);await pause(800);const during=await read();await touch('touchEnd');await pause(200);const after=await read();
    const trace=await evaluate('window.__selectionMenuTrace.dispose();window.__selectionMenuTrace.events');
    const result={during:{menu:during.menu,selected:during.selected},after:{menu:after.menu,selected:after.selected},trace};
    writeFileSync(`${output}/menu-trace.json`,JSON.stringify(result,null,2));console.log(JSON.stringify(result));
  }
  if(['all','mobile','mobile-rest'].includes(phase)){
    await command('Emulation.setDeviceMetricsOverride',{width:390,height:780,deviceScaleFactor:1,mobile:true});await pause(300);
    let p,state;
    if(phase!=='mobile-rest'){
      p=await points('selection-preview-a',replacement);
      await touch('touchStart',p.start);await pause(460);await touch('touchMove',p.end);await touch('touchEnd');await pause(220);
      state=await read();assert.equal(state.selected,replacement);assert.equal(state.menu,false);await screenshot('mobile-selection');
      await openEditor(true);await editText('暖黄的灯光落在书页上，她抬眼望向窗外。');await screenshot('mobile-editor');
      await click('.fragment-save',true);await until('!document.querySelector(".text-fragment-editor[open]")');
      const touchSaved=await read();
      assert.equal(touchSaved.a.rawOriginal??touchSaved.a.meta.swipes[1].rawOriginal,(state.a.rawOriginal??state.a.meta.swipes[1].rawOriginal).replace(replacement,'暖黄的灯光落在书页上，她抬眼望向窗外。'));reports.push('touch hold-drag selects and saves in the real conversation');
    }else{
      state=await read();assert.equal(state.a.meta.swipes[1].rawOriginal,session.raw.replace(phrase,'暖黄的灯光落在书页上，她抬眼望向窗外。'));
      reports.push('previous trusted touch save verified in restored original');
    }
    p=await points('selection-preview-a','暖黄的灯光落在书页上，她抬眼望向窗外。');
    await touch('touchStart',p.start);await pause(760);await touch('touchEnd');await pause(150);assert.equal((await read()).menu,true);await screenshot('mobile-menu');
    await evaluate('window.appBridge.getChatUI().contextMenu.style.display="none"');
    p=await points('selection-preview-a','暖黄的灯光落在书页上，她抬眼望向窗外。');
    const beforeScroll=(await read()).scroll;await touch('touchStart',p.start);await pause(45);await touch('touchMove',{x:p.start.x,y:p.start.y-90});await touch('touchEnd');await pause(250);
    state=await read();assert.notEqual(state.scroll,beforeScroll);assert.equal(state.menu,false);assert.equal(state.selected,'');
    reports.push('stationary hold retains menu; immediate swipe remains reading scroll');
    p=await points('selection-preview-a','暖黄的灯光落在书页上，她抬眼望向窗外。');
    await touch('touchStart',p.start);await pause(760);assert.equal((await read()).menu,true);
    await touch('touchMove',p.end);await touch('touchEnd');await pause(180);state=await read();assert.equal(state.menu,false);assert.equal(state.selected,'暖黄的灯光落在书页上，她抬眼望向窗外。');
    p=await points('selection-preview-a','暖黄的灯光落在书页上，她抬眼望向窗外。');
    await touch('touchStart',p.end);await pause(460);await touch('touchMove',p.start);await touch('touchCancel');await pause(180);assert.equal((await read()).selected,'');
    reports.push('drag after menu switches to selection; cancelling the gesture clears the selection');
  }
  if(phase==='show'){
    await selectMouse('selection-preview-a','暖黄的灯光落在书页上，她抬眼望向窗外。');await openEditor();
    await screenshot('real-chat-editor');reports.push('real editor left open for review');
  }
  writeFileSync(`${output}/${phase}-result.json`,JSON.stringify({passed:true,reports},null,2));console.log(JSON.stringify({passed:true,reports}));
}catch(error){await screenshot('failure').catch(()=>{});throw error;}
finally{
  await command('Emulation.setDeviceMetricsOverride',{...initial,mobile:false}).catch(()=>{});await command('Emulation.clearDeviceMetricsOverride').catch(()=>{});
  await evaluate('window.appBridge.getChatStore().flush()').catch(()=>{});client.close();
}
