import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { consumeCreativeAssistantStream } from '../../src/scripts/ui/chat/send-side-effect-utils.js';
import { createAssistantStreamRuntime } from '../../src/scripts/ui/chat/assistant-stream-runtime.js';
import { createActiveGenerationRecord, runActiveGenerationCancelFlow } from '../../src/scripts/ui/chat/generation-state-utils.js';
import { normalizeAssistantStreamChunk, createReasoningStreamEvent } from '../../src/scripts/api/native-reasoning.js';
import { createHopscotchTurnRuntime } from '../../src/scripts/ui/chat/hopscotch-turn-runtime.js';
import { createAssistantStreamUiRuntime } from '../../src/scripts/ui/chat/assistant-stream-ui-utils.js';
import { resolveCreativeMessageRawOriginal, buildAssistantBodyReasoningMeta } from '../../src/scripts/ui/chat/message-edit-transaction-utils.js';
import { resolveRegenerateFromUserIndexPlan } from '../../src/scripts/ui/chat/send-flow-utils.js';

const app = readFileSync(new URL('../../src/scripts/ui/app.js', import.meta.url), 'utf8');
const extract = (start, end) => {
  const a = app.indexOf(start), b = app.indexOf(end, a + start.length);
  assert(a >= 0 && b > a); return app.slice(a, b);
};
const source = { id:'reasoning-only', role:'assistant', type:'text', content:'', raw:'', rawSource:'', rawOriginal:'', meta:{ reasoning:'A short thought.', reasoningDisplay:'A short thought.', reasoningSource:'native:openrouter', renderRich:true } };

test('creative body pencil opens a known-empty reply while preserving native reasoning', async () => {
  const opened = [], warnings = [];
  const sandbox = vm.createContext({
    message:structuredClone(source), sessionId:'rp:test', action:'view-code',
    chatStore:{ findMessage:() => source, loadRawOriginal:async () => '' },
    ensureRenderedCancelledPartialPersisted:() => source, isRpSessionId:() => true,
    resolveActiveSwipeIndex:() => 0, getMessageFormatRepairTurnMeta:() => null,
    resolveCreativeMessageRawOriginal,
    FORMAT_REPAIR_SOURCE_KINDS:{ creativeRawOriginal:'creative_raw_original' },
    ui:{ openCodeViewer:options => opened.push(options) }, window:{ toastr:{ warning:message => warnings.push(message) } },
  });
  vm.runInContext(extract('const resolveCreativeFormatRepairRawOriginal =', 'const resolveChatFormatRepairTarget =')
    + '\nglobalThis.run = async () => {\n' + extract("if (action === 'view-code')", "if (action === 'select-voice'") + '\n};', sandbox);
  await sandbox.run();
  assert.equal(opened.length, 1, `body editor refused reasoning-only reply: ${warnings.join('; ')}`);
  assert.equal(opened[0].text, '');
  assert.equal(source.meta.reasoning, 'A short thought.');
});

test('creative reasoning-only stream survives user cancellation as a stored reply', async () => {
  const generation = createActiveGenerationRecord({ id:1, sessionId:'rp:test', userMsgId:'u' });
  const messages = [{ id:'u',role:'user',content:'Continue' }];
  const store = { findMessage:id => messages.find(m => m.id===id), appendMessage:m => { messages.push(structuredClone(m)); return m; } };
  const ctrl = { id:'reasoning-only', update() {}, isConnected:() => true, cancel:() => null };
  const runtime = createAssistantStreamRuntime({ generationId:1, sessionId:'rp:test', getActiveGeneration:() => generation,
    getStreamCtrl:() => ctrl, isSessionActive:() => true, setStreamCtrl:c => c });
  const reasoning = {raw:''};
  await consumeCreativeAssistantStream([createReasoningStreamEvent('A short thought.', {provider:'openrouter'})], {
    nativeReasoningState:reasoning, streamMeta:{id:'reasoning-only',renderRich:true},
  }, {
    normalizeChunk:normalizeAssistantStreamChunk,
    appendReasoningChunk:(state,chunk) => {state.raw+=chunk.reasoning;},
    resolveReasoningState:() => ({reasoning:reasoning.raw,reasoningDisplay:reasoning.raw,reasoningSource:'native:openrouter'}),
    pushAssistantStreamText:runtime.pushAssistantStreamText,
  });
  runActiveGenerationCancelFlow({generation,reason:'user',chatStore:store});
  const saved = store.findMessage('reasoning-only');
  assert(saved, 'reasoning-only response must survive history reload');
  assert.equal(saved.meta.reasoning, 'A short thought.');
  assert.equal(saved.meta.cancelled, true);
});

for (const stopFrom of ['composer', 'board']) test(`actual ${stopFrom} stop persists reasoning despite board cancellation callbacks`, async () => {
  const generation = createActiveGenerationRecord({id:1,sessionId:'rp:test',userMsgId:'u'});
  generation.streamPayload = structuredClone(source); generation.streamMeta = {id:source.id};
  const saved = [];
  const sandbox = vm.createContext({
    activeGeneration:generation, lastUserGenerationCancelAt:0,
    runActiveGenerationCancelFlow, recordSendFlowTraceEvent() {}, currentMemoryUpdateRuntime:null,
    window:{appBridge:{cancelCurrentGeneration() {}}}, logger:{warn() {}},
    chatStore:{getCurrent:() => 'rp:test', findMessage:id => saved.find(m=>m.id===id), appendMessage:m=>{saved.push(m);return m;}},
    getAssistantAvatarForSession:() => '', formatNowTime:() => '', refreshChatAndContacts() {},
    creativeExecutionLaneRuntime:null, ui:{setSendingState(){}}, hopscotchTurnRuntime:null,
  });
  vm.runInContext(extract('const cancelActiveGeneration =', 'const pendingGroupJoins =') + '\nglobalThis.cancel=cancelActiveGeneration;',sandbox);
  const board = { rows:[{id:'row',houses:[{id:'body',kind:'body',fused:[]}]}] };
  const runtime = createHopscotchTurnRuntime({getSettings:()=>({creativeHopscotchEnabled:true}),resolveWritingSettings:()=>({place:'writing'})});
  sandbox.hopscotchTurnRuntime=runtime;
  sandbox.generationId=1;
  const abortBody = vm.runInContext('({' + extract('abortBody: reason => {', 'charName: characterName,') + '}).abortBody',sandbox);
  const turn = runtime.prepareTurn({sessionId:'rp:test',rpUiMode:true,generationId:1,executionPlan:{source:'global',board},executorContext:{abortBody}});
  assert(turn); await turn.waitForBodyStart();
  if(stopFrom==='board') runtime.abortSessionTurn('rp:test','user');
  else sandbox.cancel('user');
  await turn.turnPromise;
  assert.equal(saved.length,1,'user stop must preserve the reasoning-only reply for reload and regenerate');
  assert.equal(saved[0].meta.reasoning,source.meta.reasoning);
  assert.equal(sandbox.activeGeneration,null);
  assert.equal(generation.cancelReason,'user');
});

test('stopping a visible reasoning reply with whitespace body stores the same bubble', () => {
  const generation = createActiveGenerationRecord({ id:2, sessionId:'rp:test', userMsgId:'u' });
  const messages = [{ id:'u',role:'user',content:'Continue' }];
  const wrapper = { dataset:{msgId:source.id}, isConnected:true, remove(){this.isConnected=false;} };
  const messageEl = { isConnected:true, closest:()=>wrapper };
  const runtime = createAssistantStreamUiRuntime({scheduleFrame:() => 1,cancelFrame(){}});
  generation.streamCtrl = runtime.startAssistantStream({
    meta:{id:source.id,renderRich:true,typing:false}, addMessage:()=>messageEl, messageBuffer:[],
    normalizeAssistantStreamState:value=>value,
    finishMessageDom:(_el,_wrapper,message)=>{wrapper.__chatappMessage=message;},
  });
  generation.streamCtrl.update({...structuredClone(source),content:'\n\n',raw:'\n\n',rawOriginal:'\n\n'});
  runActiveGenerationCancelFlow({generation,reason:'user',chatStore:{
    findMessage:id=>messages.find(m=>m.id===id),appendMessage:m=>{messages.push(m);return m;},
  }});
  assert.equal(wrapper.__chatappMessage.meta.reasoning,source.meta.reasoning);
  assert.equal(messages.length,2,'visible cancelled reasoning must be persisted before reload/swipe/reroll');
  assert.equal(messages[1].id,wrapper.__chatappMessage.id);
  assert.equal(resolveRegenerateFromUserIndexPlan({messages,userIdx:0}).canRegenerate,true);
});

test('raw source resolution preserves empty active swipes and still rejects missing originals', async () => {
  let loads=0;
  const loadRawOriginal=async()=>{loads++;return '';};
  const message={...source,rawOriginal:'previous body',meta:{...source.meta,activeSwipe:1,swipes:[{rawOriginal:'previous body'},{rawOriginal:''}]}};
  assert.equal(await resolveCreativeMessageRawOriginal({message,loadRawOriginal}),'');
  assert.equal(loads,0,'an empty active swipe must not load a stale sidecar');
  const missing={...source,content:'rendered body'};delete missing.rawOriginal;
  assert.equal(await resolveCreativeMessageRawOriginal({message:missing,loadRawOriginal}),null);
  assert.equal(await resolveCreativeMessageRawOriginal({message:missing,loadRawOriginal:async()=>'<full>body</full>'}),'<full>body</full>');
});

test('editing a body retains native reasoning but replaces/removes reasoning embedded in body tags', () => {
  assert.deepEqual(buildAssistantBodyReasoningMeta(source.meta,{content:'Added body',reasoning:''}),source.meta);
  assert.deepEqual(buildAssistantBodyReasoningMeta(source.meta,{reasoning:'body tag'}),source.meta);
  const tagged={reasoning:'old tag',reasoningDisplay:'old tag',renderRich:true};
  assert.deepEqual(buildAssistantBodyReasoningMeta(tagged,{}),{renderRich:true});
  assert.equal(buildAssistantBodyReasoningMeta(tagged,{reasoning:'new tag',reasoningDisplay:'new display'}).reasoning,'new tag');
});

test('persisted reasoning-only original stays editable after a history reload', async () => {
  globalThis.localStorage={getItem:()=>null,setItem(){},removeItem(){}};
  globalThis.document={body:{dataset:{}}};globalThis.window=globalThis;
  const realSetTimeout=globalThis.setTimeout;globalThis.setTimeout=()=>0;
  let ChatStore,sanitizeMessageForPersist;
  try {
    const module=await import('../../src/scripts/storage/chat-store.js');
    ChatStore=module.ChatStore;
    sanitizeMessageForPersist=module.__chatStoreStorageInternals.sanitizeMessageForPersist;
  }
  finally {globalThis.setTimeout=realSetTimeout;}
  const reloaded=JSON.parse(JSON.stringify(sanitizeMessageForPersist(source)));
  assert.equal(reloaded.rawOriginal,'');
  assert.equal(reloaded.meta.reasoning,source.meta.reasoning);
  let lookups=0;
  const reader={_ensureRawOriginalRef(){lookups++;return null;}};
  assert.equal(await ChatStore.prototype.loadRawOriginal.call(reader,reloaded,'rp:test'),'');
  assert.equal(lookups,0,'known-empty original must not create/load a stale sidecar');
  assert.equal(await resolveCreativeMessageRawOriginal({message:reloaded}),'');
  assert.equal(Object.hasOwn(sanitizeMessageForPersist({...source,rawOriginal:'large original'}),'rawOriginal'),false);
});
