// Windows dev WebView only. Neutral, in-memory messages; no provider calls or chat writes.
import assert from 'node:assert/strict';
import { evaluateInApp } from '../dev/cdp-client.mjs';

const result = await evaluateInApp(String.raw`(async () => {
  if (!window.__chatappBootDiag?.runtimeReady) throw new Error('Dev is not ready');
  const bridge = window.appBridge, ui = bridge.getChatUI(), store = bridge.getChatStore();
  if (ui.isSending || ui.isStreaming) throw new Error('Wait for the active generation');
  if (bridge.getUiModeContext() !== 'rp') throw new Error('Open creative writing first');
  if (ui.__chatappCodeViewer?.style.display === 'block') throw new Error('Close the current editor first');
  const { createActiveGenerationRecord, runActiveGenerationCancelFlow } = await import('/scripts/ui/chat/generation-state-utils.js');
  const { createAssistantStreamRuntime } = await import('/scripts/ui/chat/assistant-stream-runtime.js');
  const { __chatStoreStorageInternals } = await import('/scripts/storage/chat-store.js');
  const { resolveRegenerateFromUserIndexPlan } = await import('/scripts/ui/chat/send-flow-utils.js');
  const { createRpMessageActionsUiRuntime } = await import('/scripts/ui/chat/rp-message-actions-ui-utils.js');
  const sid = store.getCurrent(), originalMessages = JSON.stringify(store.getMessages(sid));
  const originals = { findMessage:store.findMessage, updateMessage:store.updateMessage };
  const host = document.createElement('section');
  host.style.cssText = 'position:fixed;inset:0;z-index:26000;padding:24px;overflow:auto;background:var(--app-surface-card);color:var(--app-text-primary)';
  document.body.append(host);
  const localUi = Object.create(ui);
  localUi.scrollEl=host;localUi.messageBuffer=[];
  localUi.setStreamingState=value=>{localUi.isStreaming=value;};
  localUi.scrollToBottom=()=>{};
  localUi.refreshScrollDateBadge=()=>{};
  localUi.scheduleScrollBottomButtonRefresh=()=>{};
  localUi.rpMessageActionsRuntime=createRpMessageActionsUiRuntime();
  localUi._unbindRpMessageActions=null;localUi._bindRpMessageActions();
  const id='creative-reasoning-smoke-'+Date.now();
  localUi.addMessage=message=>{
    const wrapper=localUi.buildMessageElement({...message,id,meta:{...message.meta,renderRich:true}});
    host.append(wrapper);return wrapper.querySelector('.QQ_chat_msgdiv');
  };
  let messages=[{id:id+'-user',role:'user',content:'本地验证'}], ctrl=null;
  const memoryStore={findMessage:mid=>messages.find(m=>m.id===mid),appendMessage:message=>{messages.push(message);return message;}};
  const thought='这是本地模拟的推理内容，停止后应保留。';
  try {
    const generation=createActiveGenerationRecord({id:1,sessionId:sid,userMsgId:id+'-user'});
    const runtime=createAssistantStreamRuntime({generationId:1,sessionId:sid,getActiveGeneration:()=>generation,
      getStreamCtrl:()=>ctrl,setStreamCtrl:value=>(ctrl=value),isSessionActive:()=>true,
      createAssistantStreamCtrl:meta=>localUi.startAssistantStream(meta)});
    runtime.pushAssistantStreamText({content:'',raw:'',rawSource:'',rawOriginal:'',meta:{renderRich:true,reasoning:thought,reasoningDisplay:thought,reasoningSource:'native:openrouter'}},{id,renderRich:true,typing:false});
    await new Promise(requestAnimationFrame);
    const stopped=runActiveGenerationCancelFlow({generation,reason:'user',chatStore:memoryStore});
    if (!stopped.commitResult?.appended) throw new Error('Cancelled reasoning was not stored');
    if (!host.textContent.includes(thought)) throw new Error('Reasoning disappeared on stop');
    messages=JSON.parse(JSON.stringify(messages.map(m=>__chatStoreStorageInternals.sanitizeMessageForPersist(m))));
    localUi.preloadHistory(messages);
    if (!host.textContent.includes(thought)) throw new Error('Reasoning disappeared on history reload');
    if (!resolveRegenerateFromUserIndexPlan({messages,userIdx:0}).canRegenerate) throw new Error('Reroll cannot find the stopped reply');
    let reply=messages.find(m=>m.id===id);
    store.findMessage=function(mid,...args){return mid===id?reply:originals.findMessage.call(this,mid,...args);};
    store.updateMessage=function(mid,patch){
      if(mid!==id) throw new Error('Unexpected real message write');
      reply={...reply,...patch};return reply;
    };
    const wrapper=host.querySelector('[data-msg-id="'+id+'"]');
    const pencil=wrapper.querySelector('[data-rp-message-action="view-code"]');
    if(!pencil) throw new Error('Body pencil missing');
    pencil.click();
    for(let i=0;i<20 && ui.__chatappCodeViewer?.style.display!=='block';i++) await new Promise(r=>setTimeout(r,25));
    const editor=ui.__chatappCodeViewer, refs=editor?.__chatappRefs;
    if(editor?.style.display!=='block'||refs.codeEl.readOnly||refs.codeEl.value!=='') throw new Error('Empty body editor did not open');
    // Exercise the real save/reparse path but skip functional side effects and persistent writes.
    editor.__chatappContext={...editor.__chatappContext,source:'agent_text_edit',canCommit:()=>true,sessionId:'rp:creative-reasoning-smoke'};
    refs.codeEl.value='补写的正文。';refs.codeEl.dispatchEvent(new Event('input',{bubbles:true}));
    refs.saveBtn.click();
    for(let i=0;i<80 && editor.style.display!=='none';i++) await new Promise(r=>setTimeout(r,25));
    if(editor.style.display!=='none') throw new Error('Editor save failed: '+refs.hint.textContent);
    if(reply.rawOriginal!=='补写的正文。'||reply.meta.reasoning!==thought) throw new Error('Body save lost native reasoning');
    if(JSON.stringify(store.getMessages(sid))!==originalMessages) throw new Error('Real chat changed');
    return {stopped:true,reloaded:true,rerollReady:true,pencilEditable:true,savedBody:true,reasoningPreserved:true,realChatUnchanged:true};
  } finally {
    store.findMessage=originals.findMessage;store.updateMessage=originals.updateMessage;
    localUi._unbindRpMessageActions?.();
    const editor=ui.__chatappCodeViewer;
    if(editor?.__chatappMessage?.id===id){editor.__chatappDirty=false;editor.__chatappRefs?.closeBtn?.click();}
    host.remove();
  }
})()`);
assert.deepEqual(result,{stopped:true,reloaded:true,rerollReady:true,pencilEditable:true,savedBody:true,reasoningPreserved:true,realChatUnchanged:true});
console.log('PASS Windows dev: stop / reload / reroll eligibility / actual pencil and save / native reasoning retained; real chat unchanged');
