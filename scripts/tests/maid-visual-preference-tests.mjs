import assert from 'node:assert/strict';
import test from 'node:test';
import {findMaidVisualPreferenceConflict, buildMaidVisualPreferenceReminder} from '../../src/scripts/agent/maid-visual-preferences.js';
import {createMaidAssistantAgent} from '../../src/scripts/agent/maid-assistant-agent.js';
import {createAgentToolRegistry} from '../../src/scripts/agent/agent-tool-registry.js';
import {createMaidMediaAssetTools} from '../../src/scripts/agent/tools/media-asset-tools.js';
import {MaidConversationStore} from '../../src/scripts/storage/maid-conversation-store.js';
import {MaidSemanticMemoryStore} from '../../src/scripts/storage/maid-semantic-memory-store.js';

// 11/21 用户定：颜色偏好冲突改成生图确认卡上的一行提醒；不中止、不由程序发问、不看用户这句话，
// 只看语义记忆与这次的生图参数。
const preference={id:'pref',kind:'preference',status:'active',explicit:true,content:'用户不喜欢粉色'};
const args={prompt:'lilith, pink hair',subject:'莉莉丝',target:'莉莉丝',purpose:'avatar',appearance:'pink hair',outfit:'black dress',style:'anime',targetAspectRatio:'1:1',negativePrompt:''};

test('the reminder depends only on remembered dislikes and the generation arguments',()=>{
 for(const [mem,changed,expected]of[
  [preference,args,true],
  [{...preference,status:'archived'},args,false],
  [{...preference,explicit:false},args,false],
  [{...preference,content:'用户不再讨厌粉色'},args,false],
  [{...preference,content:'用户不喜欢粉色背景'},args,false],
  [preference,{...args,appearance:'blue hair',prompt:'blue hair',negativePrompt:'pink hair'},false],
  [{...preference,content:'I dislike red'},{...args,appearance:'red hair',prompt:'red hair'},true],
  [{...preference,content:'I dislike red'},{...args,appearance:'hundred stars',prompt:'hundred stars'},false],
 ])assert.equal(Boolean(findMaidVisualPreferenceConflict({args:changed,preferences:[mem]})),expected,JSON.stringify([mem.content,changed.prompt]));
 assert.equal(buildMaidVisualPreferenceReminder({args,preferences:[preference,{...preference,id:'pref-2'}]}),'记忆里记着你不喜欢粉色。');
 assert.equal(buildMaidVisualPreferenceReminder({args,preferences:undefined}),'');
});

test('the image confirmation card carries the reminder line and generation still waits for the user',async()=>{
 const generated=[];
 const tool=createMaidMediaAssetTools({generateImageAttachment:async()=>{generated.push(1);return {ok:true};}}).find(item=>item.name==='media.generate_image');
 const withMemory=await tool.safety.preflight(args,{maidConversationContextRef:{current:{preferences:[preference]}}});
 assert.equal(withMemory.destructive,true);
 assert.equal(withMemory.message.split('\n').length,2);
 assert.match(withMemory.message.split('\n')[1],/记忆里记着你不喜欢粉色/);
 const plain=await tool.safety.preflight({...args,appearance:'silver hair',prompt:'lilith, silver hair'},{maidConversationContextRef:{current:{preferences:[preference]}}});
 assert.doesNotMatch(plain.message,/记忆里/);
 assert.deepEqual(generated,[]);
});

test('a remembered dislike no longer stops the run; the card shows it and the user decides',async()=>{
 const semantic=new MaidSemanticMemoryStore({storage:null,loadKv:async()=>null,saveKv:async()=>true});await semantic.load();
 await semantic.upsertMemory({kind:'preference',key:'presentation.color.dislike_pink',content:preference.content,confidence:'explicit',status:'active'});
 const store=new MaidConversationStore({storage:null,loadKv:async()=>null,saveKv:async()=>true,semanticMemoryStore:semantic});await store.load();
 const registry=createAgentToolRegistry({permissionEvaluator:{evaluateTool:()=>({decision:'allow',checks:[]})},logger:{warn(){}}});
 let billed=0;const cards=[];
 registry.registerMany(createMaidMediaAssetTools({generateImageAttachment:async()=>{billed++;return {ok:true};}}).filter(item=>item.name==='media.generate_image'));
 const agent=createMaidAssistantAgent({toolRegistry:registry,
  planner:async()=>({ok:true,featureId:'media.generate_image',toolName:'media.generate_image',args,title:'生成头像'}),
  reactPlanner:async()=>({ok:true,action:'final',message:'用户没有批准生图。'}),
  prepareConversationContext:({input,context})=>store.getContextSnapshotAsync({query:input,context}),logger:{warn(){},debug(){}}});
 const result=await agent.runPrompt('随便给莉莉丝生个头像',{roleCardId:'test',
  requestToolConfirmation:async request=>{cards.push(request);return {decision:'deny'};}});
 assert.notEqual(result.reason,'maid_visual_preference_conflict');
 assert.equal(cards.length,1);
 assert.match(cards[0].message,/记忆里记着你不喜欢粉色/);
 assert.equal(billed,0,'用户没批准就不生图');
});
