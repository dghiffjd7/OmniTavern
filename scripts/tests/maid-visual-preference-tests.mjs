import assert from 'node:assert/strict';
import test from 'node:test';
import {findMaidVisualPreferenceConflict} from '../../src/scripts/agent/maid-visual-preferences.js';
import {createMaidAssistantAgent} from '../../src/scripts/agent/maid-assistant-agent.js';
import {MaidConversationStore} from '../../src/scripts/storage/maid-conversation-store.js';
import {MaidSemanticMemoryStore} from '../../src/scripts/storage/maid-semantic-memory-store.js';
const preference={id:'pref',kind:'preference',status:'active',explicit:true,content:'用户不喜欢粉色'};
const plan={ok:true,featureId:'media.generate_image',toolName:'media.generate_image',args:{subject:'莉莉丝',appearance:'pink hair',outfit:'black dress',prompt:'lilith, pink hair',negativePrompt:''}};

test('explicit color dislikes stop a conflicting billed call even when the planner ignores the injected preference',async()=>{
 const semantic=new MaidSemanticMemoryStore({storage:null,loadKv:async()=>null,saveKv:async()=>true});await semantic.load();
 await semantic.upsertMemory({kind:'preference',key:'presentation.color.dislike_pink',content:preference.content,confidence:'explicit',status:'active'});
 const store=new MaidConversationStore({storage:null,loadKv:async()=>null,saveKv:async()=>true,semanticMemoryStore:semantic});await store.load();
 let calls=0;const agent=createMaidAssistantAgent({planner:async()=>plan,prepareConversationContext:({input,context})=>store.getContextSnapshotAsync({query:input,context}),toolRegistry:{executeTool:async()=>{calls++;return{status:'succeeded',result:{ok:true}};}},logger:{warn(){},debug(){}}});
 const result=await agent.runPrompt('随便给莉莉丝生个头像',{roleCardId:'test'});
 assert.equal(calls,0);assert.equal(result.reason,'maid_visual_preference_conflict');assert.match(result.message,/粉色/);
});

test('the preflight respects current choices, archive status and scoped dislikes',()=>{
 for(const [input,mem,args,blocked]of[
  ['随便',preference,plan.args,true],
  ['生个粉色系壁纸',preference,plan.args,false],
  ['别用黑色，给我粉色系壁纸',preference,plan.args,false],
  ['随便',{...preference,status:'archived'},plan.args,false],
  ['随便',{...preference,explicit:false},plan.args,false],
  ['随便',{...preference,content:'用户不再讨厌粉色'},plan.args,false],
  ['随便',{...preference,content:'用户不喜欢粉色背景'},plan.args,false],
  ['随便',preference,{...plan.args,appearance:'blue hair',prompt:'blue hair',negativePrompt:'pink hair'},false],
  ['随便',{...preference,content:'I dislike red'},{...plan.args,appearance:'red hair',prompt:'red hair'},true],
  ['随便',{...preference,content:'I dislike red'},{...plan.args,appearance:'hundred stars',prompt:'hundred stars'},false],
 ])assert.equal(Boolean(findMaidVisualPreferenceConflict({input,plan:{...plan,args},preferences:[mem]})),blocked,JSON.stringify([input,mem.content,args]));
});
