import assert from 'node:assert/strict';
import { createBubbleSelectionEditRuntime, canEditBubbleText } from '../../src/scripts/ui/chat/bubble-selection-edit-runtime.js';

const storage = new Map();
globalThis.localStorage = { getItem:key => storage.get(key) ?? null, setItem:(key,value) => storage.set(key,String(value)), removeItem:key => storage.delete(key) };
globalThis.document = { body:{ dataset:{} } }; globalThis.window = globalThis;
const schedule = globalThis.setTimeout; globalThis.setTimeout = () => 0;
const { ChatStore } = await import('../../src/scripts/storage/chat-store.js');
globalThis.setTimeout = schedule;
const clone = value => JSON.parse(JSON.stringify(value));
const selectedText = '第二段正文。';
const source = '<think>隐藏思考。</think>\r\n\r\n第一段保持。\r\n\r\n第二段正文。\r\n\r\n第三段保持。\r\n<tableEdit>原有指令</tableEdit>';
const body = '第一段保持。\n\n第二段正文。\n\n第三段保持。';
const assistant = () => ({ id:'a1',role:'assistant',type:'text',status:'sent',rawOriginal:source,rawSource:body,raw:body,content:body,
  meta:{reasoning:'隐藏思考。',variableSnapshot:{value:8},formatFunctionLedger:{done:true},activeSwipe:1,swipes:[
    {rawOriginal:'另一个分支。',raw:'另一个分支。',content:'另一个分支。'},
    {rawOriginal:source,rawSource:body,raw:body,content:body,variableSnapshot:{value:8}},
  ]} });
const setup = (message = assistant(), options = {}) => {
  const store = new ChatStore({scopeId:'selection-test'}), writes = [];
  store._persist = () => {}; store._persistRawOriginal = () => {}; store._deleteRawOriginal = () => {};
  const context = {sessionId:'rp:selection',scopeId:'selection-test',archiveId:'archive-1',place:'writing'};
  store._ensureSession(context.sessionId); store.state.sessions[context.sessionId].messages = [clone(message)];
  const runtime = createBubbleSelectionEditRuntime({getContext:() => ({...context}),findMessage:(mid,sid) => store.findMessage(mid,sid),
    loadOriginal:async current => current.meta?.swipes?.[current.meta.activeSwipe]?.rawOriginal ?? current.rawOriginal,
    getEnvelope:sid => ({...store.getLastRawResponseEnvelope(sid),archiveId:store.getCurrentArchiveId(sid)||''}),
    renderContent:current => current.raw,
    commit:change => {const result=store.updateMessageTextSelection(change);if(result)writes.push(change);return result;},...options});
  return {store,context,runtime,writes,open:() => runtime.open({messageId:message.id,selectedText})};
};

{
  const f=setup(), before=clone(f.store.findMessage('a1',f.context.sessionId)), draft=await f.open();
  assert.equal(f.writes.length,0,'opening has no writes'); assert.equal(await draft.save(draft.text),false);
  await draft.save('改写后的句子。\n新增一句。');
  const after=f.store.findMessage('a1',f.context.sessionId);
  assert.equal(after.rawOriginal,source.replace(selectedText,'改写后的句子。\r\n新增一句。'));
  assert.equal(after.raw,body.replace(selectedText,'改写后的句子。\n新增一句。'));
  assert.equal(after.content,after.raw); assert.deepEqual(after.meta.swipes[0],before.meta.swipes[0]);
  assert.equal(after.meta.swipes[1].rawOriginal,after.rawOriginal);
  assert.deepEqual(after.meta.variableSnapshot,before.meta.variableSnapshot);
  assert.deepEqual(after.meta.formatFunctionLedger,before.meta.formatFunctionLedger);
  assert.equal(after.meta.reasoning,before.meta.reasoning); assert.equal(f.writes.length,1);
  await assert.rejects(draft.save('重复保存'),/已变化/);
  console.log('ok - local save preserves hidden blocks, CRLF, other branches and execution state');
}
{
  const f=setup({id:'u1',role:'user',type:'text',status:'sent',rawInput:body,raw:body,content:body});
  await (await f.open()).save('自己的修改。');
  const current=f.store.findMessage('u1',f.context.sessionId);
  assert.equal(current.rawInput,body.replace(selectedText,'自己的修改。'));
  assert.equal(current.content,current.raw);assert(current.editedAt>0);
  console.log('ok - user text keeps raw input and saved display in sync');
}
{
  for (const change of [f=>{f.context.sessionId='other';},f=>{f.context.archiveId='other';},f=>{f.context.scopeId='other';},
    f=>{f.store.findMessage('a1',f.context.sessionId).meta.activeSwipe=0;},
    f=>{f.store.findMessage('a1',f.context.sessionId).meta.swipes[1].rawOriginal+='变更';},
    f=>{f.store.state.sessions[f.context.sessionId].messages=[];}]) {
    const f=setup(),draft=await f.open();change(f);await assert.rejects(draft.save('不得写入'),/已变化/);assert.equal(f.writes.length,0);
  }
  console.log('ok - session, archive, persona, swipe, source change and deletion reject stale saves');
}
{
  let release;
  const f=setup(undefined,{loadOriginal:() => new Promise(resolve=>{release=resolve;})});
  const opening=f.open();f.store.findMessage('a1',f.context.sessionId).meta.activeSwipe=0;release(source);
  await assert.rejects(opening,/已变化/);assert.equal(f.writes.length,0);
  let resume;
  const g=setup(undefined,{getSourceTurn:() => new Promise(resolve=>{resume=resolve;})});g.context.place='chat';
  const waiting=g.open();await Promise.resolve();g.store.findMessage('a1',g.context.sessionId).meta.swipes[1].rawOriginal+='外部改动';resume(null);
  await assert.rejects(waiting,/已变化/);assert.equal(g.writes.length,0);
  console.log('ok - async source loading cannot capture a switched branch or overwrite a newer original');
}
{
  const f=setup(),draft=await f.open();
  for (const text of ['<tableEdit>新增指令</tableEdit>','<think>隐藏新增内容</think>']) {
    await assert.rejects(draft.save(text),/功能标签/);assert.equal(f.writes.length,0);
  }
  const repeated=setup({id:'a1',role:'assistant',raw:'第二段正文。第二段正文。',content:body});
  await assert.rejects(repeated.open(),/准确对应/);
  const missingOriginal=assistant();delete missingOriginal.meta.swipes[1].rawOriginal;
  await assert.rejects(setup(missingOriginal).open(),/准确对应/,'a branch without its own original must not borrow another branch original');
  assert.equal(canEditBubbleText({id:'a',role:'assistant',status:'sending'}),false);
  assert.equal(canEditBubbleText({id:'a',role:'assistant',meta:{generatedMedia:{kind:'image'}}}),false);
  console.log('ok - ambiguous text and new hidden/function blocks are refused without writes');
}
{
  const f=setup({id:'a1',role:'assistant',type:'text',raw:body,rawSource:body,content:body},{
    getSourceTurn:async () => ({ok:true,sourceKind:'social_turn_raw',sourceSessionId:'source',sourceText:envelopeText}),
  });
  const envelopeText='<msg_start>角色|12:00\n'+body+'\n<msg_end>\n<msg_start>角色|12:01\n另一条气泡保持。<msg_end>';
  f.context.place='chat';f.store.setLastRawResponse(envelopeText,'source',{turnId:'t1',targetSessionId:f.context.sessionId});
  for(const messageId of ['a1','a2'])f.store.registerLastRawResponseSourceMessage({sourceSessionId:'source',turnId:'t1',targetSessionId:f.context.sessionId,messageId});
  const before=f.store.getLastRawResponseEnvelope('source'),draft=await f.open();
  await draft.save('同步到完整原文。');
  assert.deepEqual(f.store.getLastRawResponseEnvelope('source'),{...before,text:envelopeText.replace(selectedText,'同步到完整原文。')});
  assert.equal(f.store.findMessage('a1',f.context.sessionId).raw,body.replace(selectedText,'同步到完整原文。'));
  const snapshot=clone(f.store.state.sessions),result=f.store.updateMessageTextSelection({messageId:'a1',sessionId:f.context.sessionId,patch:{raw:'错误'},
    sourceEnvelope:{sourceSessionId:'source',expected:before,text:'错误'}});
  assert.equal(result,null);assert.deepEqual(f.store.state.sessions,snapshot);
  console.log('ok - message and full source turn update together, preserving other bubbles and envelope membership');
}
{
  const f=setup();const current=f.store.findMessage('a1',f.context.sessionId);
  current.meta.autoImagePromptRawContent=body+'<image_prompt>原来的图片</image_prompt>';
  current.meta.swipes[1].autoImagePromptRawContent=current.meta.autoImagePromptRawContent;
  current.meta.generatedInlineImages=[{prompt:'原来的图片',token:'[img-existing]'}];
  await(await f.open()).save('调整正文。');
  const saved=f.store.findMessage('a1',f.context.sessionId);
  assert.equal(saved.meta.autoImagePromptRawContent,current.meta.autoImagePromptRawContent.replace(selectedText,'调整正文。'));
  assert.deepEqual(saved.meta.generatedInlineImages,current.meta.generatedInlineImages);
  console.log('ok - pending image source text follows the edit while generated assets are preserved');
}
{
  const f=setup({id:'a1',role:'assistant',type:'text',rawOriginal:selectedText,raw:selectedText,content:selectedText});
  let deleted=0;f.store._deleteRawOriginal=()=>deleted++;
  await(await f.open()).save('');assert.equal(f.store.findMessage('a1',f.context.sessionId).rawOriginal,'');assert.equal(deleted,1);
  console.log('ok - deleting the complete selection clears its old disk original');
}
