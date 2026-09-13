import assert from 'node:assert/strict';
import { normalizeAgentConfiguration } from '../../src/scripts/storage/agent-config-store.js';
import { allowsAgentInvocation, getAgentInvocationMode, createInputRequestBudget } from '../../src/scripts/agent/agent-invocation.js';
import { createInputAgentRuntime } from '../../src/scripts/agent/input-agent-runtime.js';
import { createFormatReviewExecutor } from '../../src/scripts/ui/chat/format-review-runtime.js';

assert.equal(getAgentInvocationMode({ id: 'text_completion', triggerMode: 'auto' }), 'auto');
assert.equal(getAgentInvocationMode({ id: 'reply_check', triggerMode: 'auto' }), 'both');
assert.equal(getAgentInvocationMode({ id: 'reply_check', triggerMode: 'manual' }), 'manual');
for (const mode of ['auto','manual','both']) {
  const config = normalizeAgentConfiguration({ invocationMode:mode, enabled:true }, 'input-agent:test');
  assert.equal(allowsAgentInvocation(config,'auto'), mode !== 'manual');
  assert.equal(allowsAgentInvocation(config,'manual'), mode !== 'auto');
  const disabled = normalizeAgentConfiguration({...config,enabled:false},config.id);
  assert.equal(disabled.invocationMode,mode); assert.equal(allowsAgentInvocation(disabled),false); assert.equal(allowsAgentInvocation(disabled,'manual'),false);
}
let time=0; const budget=createInputRequestBudget({ maxPerMinute:2,now:()=>time });
assert(budget.take('a')); assert(budget.take('a')); assert(!budget.take('a')); time=60000; assert(budget.take('a'));
console.log('ok - independent enable/mode, legacy migration and shared request budget');

const ctx={place:'writing',scopeId:'u',sessionId:'rp:a',archiveId:'1'};
let snapshot={context:ctx,contextKey:'a',revision:1,text:'旧句。',start:0,end:3,available:true,active:true,composing:false,messages:[]};
let config=normalizeAgentConfiguration({enabled:true,invocationMode:'both',inputOutput:'rewrite',modelMode:'profile',modelProfileId:'mock',prompt:'润色这句。'},'input-agent:test');
let calls=0,writes=0,reviews=0,accept=false,hold=null,reviewHold=null;
const timers=new Set();
const runtime=createInputAgentRuntime({
 getSnapshot:()=>snapshot,getConfig:()=>config,listConfigs:()=>[config],captureModel:async()=>({}),
 request:async req=>{calls++; if(hold)return hold.promise; return config.inputOutput==='rewrite'?JSON.stringify({protocolVersion:'format_patch.v1',baseRevision:req.baseRevision,status:'patch',linePatches:[{startLine:1,endLine:1,originalLines:['旧句。'],replacementLines:['新句。']}],repairSummary:'修改措辞'}):'独立建议';},
 review:async options=>{reviews++; if(reviewHold)await reviewHold.promise;return {confirmed:accept,changed:true,candidateText:'新句。'};},
 commit:({snapshot:saved,target,text,canCommit})=>{assert(canCommit());assert.equal(saved.text,snapshot.text);writes++;snapshot={...snapshot,text:snapshot.text.slice(0,target.start)+text+snapshot.text.slice(target.end),revision:snapshot.revision+1};return true;},
 setTimer:(fn,ms)=>{const timer={fn,ms};timers.add(timer);return timer;},clearTimer:timer=>timers.delete(timer),
});
const run=options=>runtime.run({agentId:config.id,...options});
await run(); const first=runtime.list().at(-1); assert.equal(first.status,'ready');assert.equal(writes,0);
await run();assert.equal(calls,1,'same target deduplicated');
assert.equal(await runtime.apply(first.id),false);assert.equal(reviews,1);assert.equal(writes,0);
accept=true;assert.equal(await runtime.apply(first.id),true);assert.equal(writes,1);assert.equal(snapshot.text,'新句。');
snapshot={...snapshot,text:'旧句。',revision:3}; await run(); const stale=runtime.list().at(-1);snapshot={...snapshot,text:'用户继续编辑',revision:4};assert.equal(await runtime.apply(stale.id),false);assert.equal(writes,1);
console.log('ok - validated draft patch, diff confirmation, deduplication and stale draft');

const deferred=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve};};
snapshot={...snapshot,text:'旧句。',revision:5}; hold=deferred();const inFlight=run();await Promise.resolve();await Promise.resolve();const id=runtime.list().at(-1).id;
runtime.cancel(id);hold.resolve('late');await inFlight;assert.equal(runtime.list().at(-1).status,'cancelled');hold=null;
config={...config,invocationMode:'manual',inputOutput:'note'};const manualCalls=calls;runtime.schedule();await [...timers].find(t=>t.ms===900).fn();assert.equal(calls,manualCalls);
const before=calls;config={...config,invocationMode:'auto'};assert.equal((await run()).status,'skipped');assert.equal(calls,before);
runtime.schedule();await [...timers].filter(t=>t.ms===900).at(-1).fn();assert.equal(calls,before+1);assert.equal(runtime.list().at(-1).status,'ready');
config={...config,enabled:false};runtime.reconcile();assert.equal(runtime.list().at(-1).status,'expired');
config={...config,enabled:true,invocationMode:'both'};snapshot={...snapshot,composing:true};assert.equal((await run()).status,'skipped');snapshot={...snapshot,composing:false};
config={...config,inputOutput:'rewrite'};await run();reviewHold=deferred();const reviewing=runtime.apply(runtime.list().at(-1).id);await Promise.resolve();snapshot={...snapshot,context:{...ctx,archiveId:'2'}};reviewHold.resolve();assert.equal(await reviewing,false);assert.equal(writes,1);
runtime.dispose();
console.log('ok - cancellation, manual-only does not auto-run, auto-only cannot be forced, IME and archive guards');

let feature={enabled:true,invocationMode:'both'}, previews=0, finish, formatScope='a';
const format=createFormatReviewExecutor({getConfig:()=>feature, getPlace:()=> 'writing',getGuide:()=>'<tableEdit>',getScope:()=>formatScope,
 findMessage:()=>({id:'m',role:'assistant',content:'text'}),resolveTarget:async()=>({ok:true,sourceText:'text'}),
 buildOptions:()=>({enabled:true,modelReview:{enabled:true,backgroundChat:()=>{}}}),createRevision:()=> 'r',
 runPreview:options=>{previews++;finish=()=>options.onChatFormatGuardianModelReviewCompleted({});return {modelReviewQueued:true};},onPreview:()=>{},onRun:()=>{},onQueued:()=>{},
});
const running=format({sessionId:'s',messageId:'m',automatic:true});await Promise.resolve();
assert.equal((await format({sessionId:'s',messageId:'m'})).status,'skipped');assert.equal(previews,1);
feature={...feature,enabled:false};format.reconcile();assert.equal((await running).status,'cancelled');finish();
feature={enabled:true,invocationMode:'auto'};assert.equal((await format({sessionId:'s',messageId:'m'})).status,'skipped');assert.equal(previews,1);
console.log('ok - format auto/manual deduplication and master-off cancellation');

const { findManualHopscotchDependencies } = await import('../../src/scripts/ui/chat/hopscotch-activation-utils.js');
assert.deepEqual(findManualHopscotchDependencies({rows:[{houses:[{id:'next',kind:'custom_prompt',config:{prompt:'{{house:upstream}}'}}]}]}, {houses:{upstream:{invocationMode:'manual'}}}), [{houseId:'next',dependencyId:'upstream'}]);
console.log('ok - automatic dependencies flag manual-only upstream agents');
